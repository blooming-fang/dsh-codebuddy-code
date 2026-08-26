/**
 * Serialize harness messages into CodeBuddy chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool results become separate tool messages. Assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns, mirroring the
 * DeepSeek thinking-mode passback rule the gateway serves unchanged. Core
 * image blocks are rejected explicitly because this wire route is text-only.
 *
 * Port of `packages/llm/llm-codebuddy/src/serialize.ts`.
 * @module dsh-codebuddy-code/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('The CodeBuddy chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Validate the adapter-owned effort before resolving its CodeBuddy wire
 * fields. `off` is a legal harness effort but never a legal wire
 * `reasoning_effort` (the gateway rejects it with HTTP 400
 * `invalid_reasoning_effort`); the mapping happens in {@link resolveThinking}.
 */
function reasoningEffort(effort) {
  if (effort === 'off' || effort === 'high' || effort === 'max') return effort
  throw new LlmError(
    `CodeBuddy does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options, defaults) {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `CodeBuddy deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // gateway replays message.content verbatim (which is "") and some
    // gateways reject null outright. Reasoning-ONLY turns (the model can
    // answer entirely in the reasoning channel): a null here bricks every
    // later turn of that session, so the durable log always carries "".
    content: text,
    // Reasoning passback rule: reasoning_content must return on tool-call
    // turns (thinking mode); it is ignored on plain turns, so we drop it
    // there to save tokens.
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{ role: 'tool' }` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages) {
  const wire = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the gateway wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`); optional
 * fields are omitted rather than sent as null, so provider defaults apply.
 * No `stream_options` is sent: the CodeBuddy gateway attaches `usage` to the
 * finish chunk without it, and the reference client never sends it.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(options, defaults = {}) {
  const messages = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
  const resolvedThinking = resolveThinking(options, defaults)

  return {
    model: options.model,
    messages,
    stream: true,
    ...(resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {}),
    ...(resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}