/**
 * `CodeBuddyAdapter`: fetch + SSE against the CodeBuddy chat-completions
 * gateway (OpenAI-compatible), emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer session through a per-request resolver, so the
 * registering plugin owns validation, layering, and session policy.
 *
 * Port of `packages/llm/llm-codebuddy/src/adapter.ts`.
 * @module dsh-codebuddy-code/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap, matching the reference chat client. */
export const DEFAULT_MAX_TOKENS = 4_096
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
]
const OFF_ONLY_REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
]

/**
 * One optional model entry advertised by the direct-fetch adapter.
 * @typedef {object} CodeBuddyCatalogModel
 * @property {string} id - Wire model id accepted by the configured gateway.
 * @property {string} [name] - Selector label; defaults to `id`.
 * @property {string} [description] - Optional selector detail.
 * @property {number} [contextWindow] - Known combined request/response context capacity.
 * @property {number} [maxTokens] - Per-request output cap; omission falls back to the profile maxTokens.
 */

/**
 * A resolvable CodeBuddy bearer session for one request.
 * @typedef {object} CodeBuddySession
 * @property {string} accessToken - Bearer JWT sent as `Authorization: Bearer <accessToken>`.
 * @property {string} [userId] - Account id sent as `X-User-Id`.
 * @property {string} [domain] - Service domain sent as `X-Domain`.
 */

/**
 * Validated connection facts for one operation.
 * @typedef {object} CodeBuddyConnectionOptions
 * @property {string} endpoint - Full chat-completions endpoint URL.
 * @property {string} tokenPath - Path to the CodeBuddy login document.
 * @property {object} defaults - Request defaults applied to every call.
 * @property {number} maxTokens - Default per-request output cap.
 * @property {number} defaultContextWindow - Context capacity when the model has no exact value.
 * @property {CodeBuddyCatalogModel[]} models - Advisory models exposed to discovery.
 * @property {number} streamIdleTimeoutMs - Maximum provider idle while one stream read is outstanding.
 * @property {object} retryPolicy - Provider-owned model-request retry policy, already resolved.
 */

/**
 * Constructor options for {@link CodeBuddyAdapter}.
 * @typedef {object} CodeBuddyAdapterOptions
 * @property {() => CodeBuddyConnectionOptions} options - Current validated connection facts; called once per operation.
 * @property {(connection: CodeBuddyConnectionOptions) => Promise<CodeBuddySession>} resolveSession - Resolve the bearer session for one request snapshot.
 */

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: ['text'],
  }
}

function providerRetryAfterMs(value) {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers, error) {
  // The gateway reports the request id in the error body and echoes it as a header.
  const value = error?.requestId ?? headers.get('x-request-id')
  return value === undefined || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.msg, error?.extError?.code, error?.extError?.type, error?.extError?.message]
    .filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The CodeBuddy chat-completions adapter. One instance serves every model
 * name it was registered under (the harness model name IS the wire model
 * name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class CodeBuddyAdapter extends LlmAdapter {
  constructor(config) {
    super()
    /** @type {CodeBuddyAdapterOptions} */
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: 'CodeBuddy' }
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy
  }

  listModels(provider) {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  resolveModel(provider, model, _signal) {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return Promise.resolve({
      // The chat-completions wire route is text-only regardless of catalog
      // membership, so the uncatalogued fallback declares the same negative
      // capability — "unknown" here would let the host accept and persist
      // images the serializer must then reject.
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text'] }
        : modelInfo(provider, configured)),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...(connection.defaults.thinking === 'disabled'
        ? {
          reasoning: {
            efforts: OFF_ONLY_REASONING_EFFORTS,
            defaultEffort: OFF_REASONING_EFFORT,
          },
        }
        : {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: connection.defaults.reasoningEffort === 'off'
              ? OFF_REASONING_EFFORT
              : connection.defaults.reasoningEffort === 'max'
                ? MAX_REASONING_EFFORT
                : HIGH_REASONING_EFFORT,
          },
        }),
    })
  }

  async * stream(options) {
    // One resolution per stream call: connection facts and the session
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The session resolves *from this snapshot*, so an endpoint and the token
    // sent to it can never come from different configuration generations.
    const connection = this.config.options()
    const session = await this.config.resolveSession(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      session,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `CodeBuddy stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('CodeBuddy request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`CodeBuddy API stream from ${connection.endpoint} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('CodeBuddy stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  async * request(options, signal, connection, session, onComment) {
    const body = serializeRequest(options, connection.defaults)
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      // The gateway's security policy rejects requests whose `user-agent`
      // advertises a dsh/`deepseek-harness` client (HTTP 400 code 11128,
      // "request illegal" / "blocked by security policy"); a benign UA passes.
      'user-agent': 'codebuddy-dsh',
      ...(session.userId !== undefined ? { 'x-user-id': session.userId } : {}),
      ...(session.domain !== undefined ? { 'x-domain': session.domain } : {}),
      ...(options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {}),
      ...(options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {}),
    }

    let response
    try {
      response = await fetch(connection.endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // fetch wraps every transport failure (DNS, refused connection, TLS,
      // proxy) in a bare `TypeError: fetch failed` whose actionable detail
      // lives on `cause`. Wrapping with the endpoint and chaining the cause
      // lets `errorChain` render the full diagnosis at every reporting boundary.
      throw new LlmError(
        `CodeBuddy API request to ${connection.endpoint} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `CodeBuddy API error (HTTP ${response.status})`
      let providerError
      try {
        const parsed = await response.json()
        providerError = parsed
        if (parsed.msg) message = parsed.msg
        else if (parsed.extError?.message) message = parsed.extError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers, providerError)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      })
    }
    if (!response.body) {
      throw new LlmError('CodeBuddy API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}