/**
 * Translate CodeBuddy SSE payloads with one stateful harness block per
 * content, reasoning, or tool call index. An empty initial reasoning delta
 * does not open a block. Finish reason and the latest usage are deferred until
 * `[DONE]`, covering both finish-attached and trailing usage-only shapes while
 * ensuring no chunk follows `finish`. The gateway's legacy `function_call`
 * delta field is deliberately not read: real tool calls arrive through
 * `tool_calls`.
 *
 * Port of `packages/llm/llm-codebuddy/src/translate.ts`.
 * @module dsh-codebuddy-code/translate
 */

import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.js'

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{ kind: 'error' }` with the uppercased value as `code`.
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. CodeBuddy's `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`); the
 * harness TokenUsage convention is DISJOINT counts, so cache reads are
 * subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage

  function open(kind) {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        // The gateway sends the tool name ONLY on the first delta of a call
        // and "" on every later delta; overwriting with the empty value would
        // erase the recorded name and produce a nameless tool call that the
        // provider rejects on the next turn (`model_param_invalid`).
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
          block.name = call.function.name
        }
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}