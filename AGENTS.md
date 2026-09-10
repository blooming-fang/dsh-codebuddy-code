# AGENTS.md

This file governs work inside `plugins/dsh-codebuddy-code/`, a self-contained profile bundle that registers Tencent CodeBuddy as an LLM provider for the DeepSeek Harness web GUI. The enclosing deepseek-harness repo's root `AGENTS.md` conventions still apply; this file adds the bundle-specific contracts and the invariants that must not be regressed.

## What this bundle is

`dsh-codebuddy-code` is **not** a chat panel and **not** a thin wrapper on a workspace package. It is a self-contained JS port of `packages/llm/llm-codebuddy` (the workspace TypeScript adapter, `rc.5`) that ships its adapter **inside** the bundle. The web profile installs this package; the workspace package is a separate, parallel implementation for source-checkout runs of dsh. Keep them behaviorally in sync but do not depend on the workspace package here.

It plugs into the harness `ctx.llm` seam:

- `ctx.llm.registerConfigurableProviders([{ provider: 'codebuddy', displayName: 'CodeBuddy', settingsNs: 'llm-codebuddy', settingsPath: [] }])` makes the **Settings → Models** card appear.
- The registered adapter's `listModels` / `resolveModel` make its models appear in the chat composer model picker.
- The model picker entry and the wire model id are the same string.

## Credentials model

The bearer session is the **machine's CodeBuddy (or WorkBuddy) login**, not a product API key. No credential seam is involved, so the web Models page shows this provider with its settings form and **no credential dot**. Per request, in order:

1. Env overrides `CODEBUDDY_AUTH_TOKEN`, then `CODEBUDDY_API_KEY`.
2. The desktop CodeBuddy login document at `tokenPath`, defaulting to `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`, read with an expiry check.
3. Only when CodeBuddy is not logged in, the desktop WorkBuddy login document at `workbuddyTokenPath`, defaulting to `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`. Both products write the same document shape.

When none exists/valid, a request fails with `LlmError` code `MISSING_CREDENTIAL` — never at plugin load. The failure message lists why each candidate was rejected.

## Directory structure

```
dsh-codebuddy-code/
├── package.json       # declares dsh.bundle.patch + peer deps on the in-closure runtime
├── cordis.patch.yml   # bundle layer: inserts the single `llm-codebuddy` plugin row
├── src/
│   ├── index.js       # plugin entry: provider route, settings section, session resolver
│   ├── adapter.js     # CodeBuddyAdapter: fetch + SSE, transport-only, thunk-driven config
│   ├── serialize.js   # harness messages → CodeBuddy chat-completions wire request
│   ├── translate.js   # wire chunk → harness StreamChunk
│   ├── sse.js         # SSE byte stream → data payloads (eventsource-parser)
│   └── types.js       # wire-format documentation (no runtime code)
└── scripts/
    ├── check-pack.mjs # prepack gate: bundle completeness before npm pack/publish
    └── cb-proxy.mjs   # local capture proxy for diagnosing tool-call failures
```

Each `src/*.js` module is the direct port of the matching `packages/llm/llm-codebuddy/src/*.ts`. A module's docstring names its TS source-of-truth twin.

## Non-negotiable invariants

These are hard-won gateway behaviors. Reverting any of them breaks real requests; the README records the observed failure modes as a warning. Do not "clean up" them.

- **Tool `function.name` appears only on the first SSE delta of a call**; every later delta carries `""`. The translator updates the recorded call name only when `name` is a non-empty string. Reverting to `name !== undefined` erases real names, produces `unknown tool ""`, and the next turn's `name: ""` back to the gateway returns HTTP 400 `model_param_invalid` ("the request parameters were rejected by the model provider"). See `translate.js` `tool_calls` handling.
- **The gateway's security policy rejects a `user-agent` that advertises dsh / `deepseek-harness`** (HTTP 400 code `11128`, "request illegal" / "blocked by security policy"). The adapter sends `user-agent: codebuddy-dsh`. Do **not** switch to the harness `attributionHeaders()`; every request would be rejected.
- **`reasoning_effort: 'off'` is legal in the harness but rejected by the gateway** (HTTP 400 `invalid_reasoning_effort`). The serializer maps the `off` effort to `thinking: { type: 'disabled' }` and never emits `reasoning_effort: 'off'`. See `resolveThinking`.
- **Assistant `content` must be `""`, never `null`** — including on pure tool-call and reasoning-only turns. `null` bricks every later turn of that session. See `serializeAssistant`.
- **`reasoning_content` is replayed only on tool-call turns** (thinking mode), mirroring the DeepSeek passback rule; it is dropped on plain turns to save tokens.
- **`stream_options` is never sent**; the gateway attaches `usage` to the finish chunk without it.
- **This wire route is text-only.** Core image content is rejected explicitly with `UNSUPPORTED_CONTENT`; both the catalog and the uncatalogued fallback declare `inputModalities: ['text']`.
- **`user` tool results** (harness vocabulary) become standalone `role: 'tool'` wire messages; empty tool output is sent as `'(no output)'` so the wire always carries content.
- **Do not add runtime validation at typed same-process boundaries** for values the static interfaces guarantee; validate in `resolveAdapterOptions` (the one explicit resolve step) and at wire boundaries.

## Connection facts resolution

The adapter is transport-only. Connection facts arrive through an `options()` thunk resolved **once per operation**, and the bearer session through a per-request `resolveSession(connection)`. In `stream()`, one snapshot is taken and held for the whole request, so an in-flight stream never observes a config change, and the endpoint and the token sent to it always come from the same generation.

`resolveAdapterOptions` is the single explicit resolve step from raw config to validated connection facts. It re-judges every default and bound because programmatic construction can bypass Schemastery normalization. Misconfiguration fails loud at load; a live settings snapshot failing a beyond-schema bound keeps serving the last good facts and logs once.

The retry policy is captured at registration, so it is the one fact per-request resolution cannot refresh. `ensureRegistrationFacts` calls `registration.replace([PROVIDER])` when it changes — a single synchronous registry section, never dispose-then-register (which would publish an empty route set in between).

## Settings section

The `llm-codebuddy:` settings namespace (`$DSH_HOME/settings.yaml`) doubles as the plugin config schema and is installable via `installSettingsSection`. Every field is optional; changes reach the next request without restarting. Key fields: `endpoint` (default `https://copilot.tencent.com/v2/chat/completions`), `tokenPath`, `workbuddyTokenPath` (fallback WorkBuddy login document), `thinking` (`enabled`/`disabled`), `reasoningEffort` (`off`/`high`/`max`, default `off`), `maxTokens` (default 4096), `defaultContextWindow` (default 1000000), `models` (advisory catalog), `streamIdleTimeoutMs` (default 300000), `retryPolicy`.

The advisory `models` catalog (mirroring the CodeBuddy CLI's `cli` agent list: `glm-5.x`, `kimi-k3-1`/`kimi-k2.x`, `minimax-m3`/`minimax-m2.7`, `hy3`, `deepseek-v4-pro`/`deepseek-v4.1-flash`/`deepseek-v4-flash`, `deepseek-v3-2-volc`) is what discovery shows; it does not restrict which wire model ids are accepted. `resolveModel` accepts any model id, falling back to `defaultContextWindow`/`maxTokens`.

## Dependencies and closure

All dependencies are peers on the installed dsh's in-closure runtime and resolve to the same instance via the profile's module fallback; no `pnpm install` is needed after `dsh plugin add`. Peers: `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-timeout`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-util-values`, `@deepseek-ai/cordis`, plus runtime deps `@deepseek-ai/schemastery` and `eventsource-parser`. Keep peer ranges aligned with the installed dsh minor (currently `^0.1.5-rc.1`).

## cordis.patch.yml

The bundle layer inserts exactly one plugin row:

```yaml
- insert:
    - id: llm-codebuddy
      name: "dsh-codebuddy-code"
```

`name` must be the **full package specifier as installed** in the profile's `node_modules` (pnpm links packages by true name). A bare `dsh-codebuddy-code` here fails to resolve (`ERR_MODULE_NOT_FOUND`) and crashes the app on boot. `check-pack.mjs` verifies the patch references the package name.

## Packaging, install, publish

```sh
# pack (runs check-pack via prepack)
cd plugins/dsh-codebuddy-code && npm pack     # -> dsh-codebuddy-code-0.1.0.tgz

# install into the real web profile (from the parent dir or by tgz path)
dsh plugin --profile web add D:\path\to\dsh-codebuddy-code          # from source dir
dsh plugin --profile web add D:\path\to\dsh-codebuddy-code-0.1.0.tgz
dsh plugin --profile web remove dsh-codebuddy-code                   # removes deps + layer
# restart `dsh web` after install/remove
```

Publishing config is present in `package.json` (`publishConfig.access: public`, git repo URLs). **Do not actually `npm publish`** unless explicitly requested — this repo only ships the configuration. Never commit `.tgz` or `node_modules` (both gitignored); `.npmignore` additionally excludes `scripts/`, `.git/`, `.github/`, `*.log`.

## Diagnosing tool-call failures

`scripts/cb-proxy.mjs` is a local capture proxy (`127.0.0.1:18080`). Point `llm-codebuddy.endpoint` at `http://127.0.0.1:18080/v2/chat/completions`, send a request, and inspect `cb-proxy.log` for the exact request body and the first 1KB of the response. Use it when a provider call fails (`request illegal`, `the request parameters were rejected by the model provider`, etc.) before changing adapter code — most failures are the documented gateway invariants above, not adapter bugs.

## Editing this file

Keep it current with the bundle's real behavior. When the workspace twin `packages/llm/llm-codebuddy` changes, mirror the behavioral contract here only if it affects this bundle.
