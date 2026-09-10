/**
 * Serialize harness messages into CodeBuddy chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool results become separate tool messages. Assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns, mirroring the
 * DeepSeek thinking-mode passback rule the gateway serves unchanged.
 *
 * Images ride the OpenAI-family `image_url` content-part form, which the
 * CodeBuddy gateway accepts for every model it serves. Acceptance is NOT
 * capability, though: a text-only model answers an image part by silently
 * describing an image it never received. Capability is therefore gated one
 * layer up, by the adapter's declared `inputModalities`, and this module only
 * ever sees images for a model that declared them. A role the wire form cannot
 * carry images in is still rejected here rather than flattened away.
 *
 * Port of `packages/llm/llm-codebuddy/src/serialize.ts`.
 * @module dsh-codebuddy-code/serialize
 */

import { contentHasImage, LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'

/** Leading text for the user-role message that carries a tool result's images. */
const TOOL_RESULT_IMAGE_TEXT = 'Images returned by the preceding tool call.'

/**
 * Reject image content in a role the chat-completions image form cannot carry.
 * Images are representable only in user-role parts, so an image anywhere else
 * must fail loudly instead of being erased by the text join.
 * @param role - the harness message role being serialized.
 * @param blocks - that message's content blocks.
 */
function assertSupportedImageRole(role, blocks) {
  if (role !== 'user' && contentHasImage(blocks)) {
    throw new LlmError(
      `The CodeBuddy chat-completions adapter cannot represent image content in a ${role} message.`,
      'UNSUPPORTED_CONTENT',
    )
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
  assertSupportedImageRole('assistant', message.content)
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
 * Build the ordered wire parts for one user-role body, resolving every durable
 * image reference through the prepared request versions.
 *
 * Each image contributes its model-facing handle text immediately before the
 * image part, so the model can cite an occurrence by identity and is told the
 * exact preview dimensions it is looking at. Keeping the handle beside the
 * pixels (rather than in a separate message) preserves the order the harness
 * assembled. The handle part carries `imageHandle` so the tool-result path can
 * tell it apart from real tool output and move it with the image.
 *
 * @param blocks - user or nested tool-result content blocks.
 * @param images - prepared request versions and their resolved access paths.
 * @returns ordered `{type:'text'}` / `{type:'image_url'}` wire parts.
 */
function contentParts(blocks, images) {
  const parts = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = images?.requestImages.get(block.attachment.attachmentId)
        if (version === undefined) {
          throw new LlmError(
            `CodeBuddy image ${block.attachment.attachmentId} could not be prepared for this request.`
            + ' The deployment must mount the durable attachment service to send images.',
            'INVALID_REQUEST',
          )
        }
        parts.push({
          type: 'text',
          imageHandle: true,
          text: requestImageHandleText(block.attachment, version, images.resolveAccess?.(block.attachment)),
        })
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
          },
        })
        break
      }
      case 'tool-result':
        parts.push(...contentParts(block.content, images))
        break
      default:
        break
    }
  }
  return parts
}

/** Strip the internal `imageHandle` marker before a part reaches the wire. */
function wirePart(part) {
  return part.type === 'text' && part.imageHandle === true
    ? { type: 'text', text: part.text }
    : part
}

/**
 * Keep text-only user bodies on the compact string wire form; any image forces
 * the content-part array so the pixels survive.
 * @param parts - ordered wire parts from {@link contentParts}.
 * @returns a plain string when every part is text, otherwise the part array.
 */
function userContent(parts) {
  const text = []
  for (const part of parts) {
    if (part.type !== 'text' || part.imageHandle === true) return parts.map(wirePart)
    text.push(part.text)
  }
  return text.join('')
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{ role: 'tool' }` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 *
 * A tool result carrying an image cannot ride a `tool` message (the wire form
 * has no image parts there), so its images are emitted in one following
 * user-role message while the tool message keeps the text.
 *
 * @param messages - the harness conversation, in order.
 * @param images - prepared request versions, or undefined when the request carries no images.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages, images) {
  const wire = []
  // Route through the part builder whenever ANY image is present — even when
  // the caller prepared none — so a missing/unmountable attachment service
  // fails loudly instead of the text join silently erasing the image and
  // answering a question the model never saw.
  const useParts = messages.some(message => contentHasImage(message.content))
  const pendingToolImages = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages.splice(0)],
    })
  }
  for (const message of messages) {
    if (message.role === 'system') {
      assertSupportedImageRole('system', message.content)
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the gateway wants them as role:'tool' messages.
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const content = useParts
      ? userContent(contentParts(regular, images))
      : flattenText(regular)
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      const parts = useParts
        ? contentParts(result.content, images)
        : [{ type: 'text', text: flattenText(result.content) }]
      // A `tool` message carries text only, so each image and its handle text
      // move together to the following user message, order preserved.
      const carried = parts.filter(part => part.type !== 'text' || part.imageHandle === true)
      const text = parts
        .filter(part => part.type === 'text' && part.imageHandle !== true)
        .map(part => part.text)
        .join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: text || '(no output)',
      })
      pendingToolImages.push(...carried.map(wirePart))
    }
  }
  flushToolImages()
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`); optional
 * fields are omitted rather than sent as null, so provider defaults apply.
 * No `stream_options` is sent: the CodeBuddy gateway attaches `usage` to the
 * finish chunk without it, and the reference client never sends it.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @param images - prepared request versions for this call; omitted when the request carries no images.
 * @returns the chat-completions request body.
 */
export function serializeRequest(options, defaults = {}, images) {
  const messages = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages, images))

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
