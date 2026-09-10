/**
 * Register a {@link CodeBuddyAdapter} for the `codebuddy` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-codebuddy` user-settings section (`ctx.settings`), so a changed
 * endpoint, catalog, or token path reaches the very next request without
 * restarting anything, while an in-flight stream keeps the facts it started
 * with. The one registration-captured fact — the retry policy — re-registers
 * the route in place when it changes.
 *
 * The bearer session is the machine's CodeBuddy (or WorkBuddy) login, not a
 * product API key: `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY` env overrides
 * win, then the CodeBuddy login document at `tokenPath` (the desktop app's
 * auth file) is read with an expiry check, and only when CodeBuddy is not
 * logged in does the WorkBuddy login document at `workbuddyTokenPath` back it
 * up. No credential seam is involved, so the web Models page shows this
 * provider with its settings form and no credential dot.
 *
 * Self-contained port of `packages/llm/llm-codebuddy/src/index.ts` for the
 * `dsh-codebuddy-code` profile bundle. The provider appears on the web Models
 * page (via `registerConfigurableProviders`) and its models appear in the
 * composer model picker (via the adapter's `listModels`/`resolveModel`).
 * @module dsh-codebuddy-code
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  CodeBuddyAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.js'

export const name = 'llm-codebuddy'
export const inject = ['llm']

const NS = 'llm-codebuddy'
/** The single provider route this plugin owns. */
export const PROVIDER = 'codebuddy'
/** Environment overrides, in preference order, matching the reference chat client. */
const TOKEN_ENVS = ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY']

/** The chat-completions endpoint the CodeBuddy gateway serves. */
export const DEFAULT_ENDPOINT = 'https://copilot.tencent.com/v2/chat/completions'

// The advisory catalog mirrors the CodeBuddy CLI's own `cli` agent model list
// (product.internal.json — the Tencent / copilot.tencent.com build), not the
// hardcoded two-model subset previously shipped. These ids are what the
// gateway actually serves; no per-model capacity is disclosed by the product
// config, so every entry falls back to DEFAULT_CONTEXT_WINDOW.
const DEFAULT_MODELS = [
  { id: 'hy3', name: 'CodeBuddy-Hy3' },
  { id: 'glm-5.2', name: 'CodeBuddy-GLM-5.2' },
  { id: 'glm-5.1', name: 'CodeBuddy-GLM-5.1' },
  { id: 'glm-5.0', name: 'CodeBuddy-GLM-5.0' },
  { id: 'glm-5.0-turbo', name: 'CodeBuddy-GLM-5.0-Turbo' },
  { id: 'glm-5v-turbo', name: 'CodeBuddy-GLM-5V-Turbo' },
  { id: 'glm-4.7', name: 'CodeBuddy-GLM-4.7' },
  { id: 'minimax-m3', name: 'CodeBuddy-MiniMax-M3' },
  { id: 'minimax-m2.7', name: 'CodeBuddy-MiniMax-M2.7' },
  { id: 'kimi-k3-1', name: 'CodeBuddy-Kimi-K3' },
  { id: 'kimi-k2.7', name: 'CodeBuddy-Kimi-K2.7' },
  { id: 'kimi-k2.6', name: 'CodeBuddy-Kimi-K2.6' },
  { id: 'kimi-k2.5', name: 'CodeBuddy-Kimi-K2.5' },
  { id: 'deepseek-v4-pro', name: 'CodeBuddy-V4-Pro' },
  { id: 'deepseek-v4.1-flash', name: 'CodeBuddy-V4.1-Flash' },
  { id: 'deepseek-v4-flash', name: 'CodeBuddy-V4-Flash' },
  { id: 'deepseek-v3-2-volc', name: 'CodeBuddy-V3.2-Volc' },
].map(model => ({ ...model, contextWindow: DEFAULT_CONTEXT_WINDOW }))

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-codebuddy` settings-section shape. Every field is optional in
 * yml: a missing session resolves from the environment or the local CodeBuddy
 * login document at each request (a request without any session fails with
 * `MISSING_CREDENTIAL`, not at plugin load), omitted thinking mode uses the
 * gateway default (disabled — the reference client never enables it), and
 * omitted reasoning effort resolves to `off`.
 * @typedef {object} Config
 * @property {string} [endpoint] - Full chat-completions endpoint URL.
 * @property {string} [tokenPath] - Path to the CodeBuddy login document.
 * @property {string} [workbuddyTokenPath] - Path to the fallback WorkBuddy login document, used only when the CodeBuddy one is not logged in.
 * @property {'enabled'|'disabled'} [thinking] - Deployment thinking policy.
 * @property {'off'|'high'|'max'} [reasoningEffort] - Default thinking effort (default `off`).
 * @property {number} [maxTokens] - Default per-request output cap (default 4,096).
 * @property {number} [defaultContextWindow] - Positive context capacity used when the selected model has no exact value.
 * @property {Array} [models] - Advisory models shown by discovery consumers.
 * @property {number} [streamIdleTimeoutMs] - Maximum provider idle time while one stream read is outstanding.
 * @property {object} [retryPolicy] - Provider-owned model-request retry policy.
 */

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config = z.object({
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  tokenPath: z.string(),
  workbuddyTokenPath: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'high', 'max']).default('off'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** The desktop app's CodeBuddy auth file name under LOCALAPPDATA; the tokenPath default. */
const TOKEN_FILE_RELATIVE = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info')

/** The desktop app's WorkBuddy auth file name under LOCALAPPDATA; the workbuddyTokenPath default. */
const WORKBUDDY_TOKEN_FILE_RELATIVE = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

/** Compute the default login-document path from the ambient platform root. */
export function defaultTokenPath() {
  const local = process.env.LOCALAPPDATA
  const base = local !== undefined && local.length > 0 ? local : join(homedir(), 'AppData', 'Local')
  return join(base, TOKEN_FILE_RELATIVE)
}

/** Compute the default WorkBuddy fallback login-document path from the ambient platform root. */
export function defaultWorkbuddyTokenPath() {
  const local = process.env.LOCALAPPDATA
  const base = local !== undefined && local.length > 0 ? local : join(homedir(), 'AppData', 'Local')
  return join(base, WORKBUDDY_TOKEN_FILE_RELATIVE)
}

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
  const seen = new Set()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-codebuddy: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-codebuddy: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-codebuddy: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-codebuddy: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-codebuddy: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config) {
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-codebuddy: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-codebuddy: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-codebuddy: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-codebuddy: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    tokenPath: config.tokenPath ?? defaultTokenPath(),
    workbuddyTokenPath: config.workbuddyTokenPath ?? defaultWorkbuddyTokenPath(),
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort ?? 'off',
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-codebuddy: retryPolicy'),
  }
}

export function apply(ctx, config) {
  let current = () => config
  let lastRaw
  let lastGood
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-codebuddy: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveSession = async (connection) => {
    // Environment overrides first, exactly as the reference client reads them.
    for (const env of TOKEN_ENVS) {
      const ambient = process.env[env]
      if (ambient !== undefined && ambient.length > 0) {
        return { accessToken: assertUsableApiKey(ambient, 'llm-codebuddy', env) }
      }
    }
    // Then the desktop app's login documents, in priority order, each read
    // with the same expiry check the reference client performs: CodeBuddy
    // first, WorkBuddy only when CodeBuddy is not logged in.
    const reasons = []
    for (const tokenPath of [connection.tokenPath, connection.workbuddyTokenPath]) {
      const session = await sessionFromDocument(tokenPath, reasons)
      if (session !== undefined) return session
    }
    throw new LlmError(
      `llm-codebuddy: no usable CodeBuddy or WorkBuddy login at ${connection.tokenPath} or`
      + ` ${connection.workbuddyTokenPath}; ${reasons.join('; ')}; log in with the CodeBuddy desktop`
      + ` app, or export ${TOKEN_ENVS.join(' / ')} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  /**
   * Resolve a bearer session from one login document, or return `undefined`
   * with the failure reason appended when the document does not carry a usable
   * token so the caller can try the next candidate. The desktop app writes the
   * same document shape for both CodeBuddy and WorkBuddy.
   */
  const sessionFromDocument = async (tokenPath, reasons) => {
    let raw
    try {
      raw = await readFile(tokenPath, 'utf8')
    } catch (cause) {
      reasons.push(`cannot read ${tokenPath}`)
      return undefined
    }
    let login
    try {
      login = JSON.parse(raw)
    } catch (cause) {
      reasons.push(`${tokenPath} is not valid JSON`)
      return undefined
    }
    if (typeof login.auth?.accessToken !== 'string' || login.auth.accessToken.length === 0) {
      reasons.push(`${tokenPath} carries no access token`)
      return undefined
    }
    if (typeof login.auth.expiresAt === 'number' && Date.now() > login.auth.expiresAt) {
      reasons.push(`${tokenPath} expired`)
      return undefined
    }
    return {
      accessToken: assertUsableApiKey(login.auth.accessToken, 'llm-codebuddy', tokenPath),
      ...(typeof login.account?.uid === 'string' && login.account.uid.length > 0
        ? { userId: login.account.uid }
        : {}),
      ...(typeof login.auth.domain === 'string' && login.auth.domain.length > 0
        ? { domain: login.auth.domain }
        : {}),
    }
  }

  const adapter = new CodeBuddyAdapter({ options, resolveSession })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'CodeBuddy', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: ensureRegistrationFacts,
    })
  })
}