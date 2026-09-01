/**
 * CodeBuddy chat-completions wire format (OpenAI-compatible gateway over
 * https://copilot.tencent.com/v2/chat/completions).
 *
 * The original `packages/llm/llm-codebuddy/src/types.ts` declared these as
 * TypeScript interfaces; in this JS port the wire shapes are documented here
 * and the config/connection shapes live on the modules that read them.
 *
 * Two deviations from the DeepSeek twin are structural: the gateway DEFAULTS
 * thinking off (an explicit `thinking: { type: 'enabled' }` is required to
 * see reasoning), and `reasoning_effort: 'off'` is rejected with HTTP 400
 * `invalid_reasoning_effort`, so the adapter maps the harness `off` effort to
 * `thinking: { type: 'disabled' }` and never serializes `reasoning_effort: 'off'`.
 *
 * @module dsh-codebuddy-code/types
 */

// Wire request body: { model, messages, stream: true, thinking?, reasoning_effort?,
// _effort?, tools?, temperature?, max_tokens?, stop? }. See serialize.js for
// the exact emission rules.

// Wire message: discriminated on `role` (system | user | assistant | tool). See
// serialize.js for how harness messages map to them.

// Wire chunk (a parsed SSE `data:` payload): { choices?, usage? }. See
// translate.js for how chunks assemble into harness StreamChunks.

// Wire error body: { code?, msg?, requestId?, extError? }. See adapter.js for
// how a non-2xx response maps to a stable LlmError code.

// The login document written by the desktop app at tokenPath
// (%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info),
// with the WorkBuddy fallback at workbuddyTokenPath (...\auth\workbuddy-desktop.info).
// Both products write the same shape; only the fields the session resolver reads
// are named here:
//   { account: { uid, nickname?, uin?, type? }, auth: { accessToken, refreshToken?,
//     tokenType?, expiresIn?, expiresAt, domain? } }

export {}