/**
 * dsh runtime-compatibility suite: the manifest gate PLUS the real seam.
 *
 * These tests do not mock the harness. They import the running dsh's own
 * `@deepseek-ai/dsh-app-boot`, `dsh-llm`, `dsh-settings`, and `cordis`, mount
 * the plugin exactly as the Loader does, and drive a whole request through
 * `ctx.llm.stream()` with only the network stubbed. That is what makes this
 * suite able to fail on a dsh upgrade: a stale peer range, a moved seam export,
 * a changed projection order, or a request shape the adapter no longer
 * understands all surface here rather than in the running GUI.
 *
 * Like the image suite, it resolves peers through the profile's module
 * fallback, so run it from an INSTALLED copy:
 *
 *   node tests/runtime-compat.test.mjs
 *
 * It is offline: no network and no CodeBuddy login (the bearer session comes
 * from an environment override and fetch is stubbed).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log('  ok   ' + name)
    pass += 1
  } catch (error) {
    console.log('  FAIL ' + name + String.fromCharCode(10) + '       ' + error.message)
    fail += 1
  }
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

console.log(String.fromCharCode(10) + '== the bundle the running dsh will accept ==')

// The exact check dsh runs before it mounts any profile bundle. A mismatched
// "@deepseek-ai/dsh*" peer range does not fail the app loudly: the bundle is
// SKIPPED, so the CodeBuddy card and its models just disappear. 0.5.0 exists
// because 0.4.1 declared ^0.1.7-alpha.1 and was skipped exactly that way on
// dsh 0.2.0-rc.1. Prereleases participate here, so a range must admit them.
const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')

await check('every @deepseek-ai/dsh-* peer range admits the installed dsh runtime', () => {
  const issue = evaluatePluginCompatibility(manifest)
  assert.equal(
    issue,
    undefined,
    'dsh ' + getDshRuntimeVersion() + ' would skip this bundle: ' + JSON.stringify(issue?.peers),
  )
})

await check('the cordis peer range admits the installed cordis', () => {
  // The gate above ignores non-dsh packages, so this half is not covered by it:
  // cordis is the process wiring the plugin mounts onto.
  const require = createRequire(import.meta.url)
  const dir = dirname(require.resolve('@deepseek-ai/cordis/package.json'))
  const cordis = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const declared = manifest.peerDependencies['@deepseek-ai/cordis']
  assert.equal(
    declared,
    '^' + cordis.version,
    'declared ' + declared + ', installed cordis ' + cordis.version,
  )
})

console.log(String.fromCharCode(10) + '== the plugin mounts on the real '
  + getDshRuntimeVersion() + ' seam ==')

const { Context } = await import('@deepseek-ai/cordis')
const LlmRuntime = (await import('@deepseek-ai/dsh-llm')).default
const SettingsForms = (await import('@deepseek-ai/dsh-settings')).default
const plugin = await import('../src/index.js')

/** Mount the plugin exactly as the profile loader does, on the real services. */
const mount = async (config = {}) => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SettingsForms)
  await ctx.plugin(plugin, config)
  return ctx
}

const collect = async (iterable) => {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

// The bearer session resolves from the environment before any login document.
process.env.CODEBBUDDY_AUTH_TOKEN = 'runtime-compat-test-token'

const SSE_BODY = 'data: ' + JSON.stringify({
  choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
}) + String.fromCharCode(10, 10) + 'data: [DONE]' + String.fromCharCode(10, 10)

/** Run one request with only the network stubbed, capturing the wire bodies. */
const withStubbedFetch = async (run) => {
  const captured = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    await run(captured)
  } finally {
    globalThis.fetch = original
  }
}

/** One real request through the runtime; returns the capture and the chunks. */
const request = async (ctx, options) => {
  let chunks = []
  let captured = []
  await withStubbedFetch(async (seen) => {
    chunks = await collect(ctx.llm.stream(options))
    captured = seen
  })
  const failure = chunks.find(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error')
  return { captured, chunks, failure, body: captured[0]?.body }
}

const userText = text => ({ role: 'user', content: [{ type: 'text', text }] })

await check('the provider route, the Models-page card, and the model picker all appear', async () => {
  const ctx = await mount()
  try {
    assert.deepEqual(ctx.llm.listProviders().map(entry => entry.id), ['codebuddy'])
    assert.deepEqual(
      ctx.llm.listConfigurableProviders().map(entry => entry.provider),
      ['codebuddy'],
    )
    const models = await ctx.llm.listModels('codebuddy')
    assert.equal(models.length, 17)
    assert.deepEqual(models.find(model => model.id === 'hy3').inputModalities, ['text', 'image'])
    assert.deepEqual(models.find(model => model.id === 'glm-5v-turbo').inputModalities, ['text'])
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('exact-model resolution reports context, output cap, and efforts', async () => {
  const ctx = await mount()
  try {
    const info = await ctx.llm.resolveModelInfo('codebuddy', 'hy3')
    assert.equal(info.provider, 'codebuddy')
    assert.equal(info.context.contextWindow, 1_000_000)
    assert.equal(info.defaultMaxTokens, 384_000)
    assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['off', 'high', 'max'])
    assert.equal(info.reasoning.defaultEffort, 'off')
    // An uncatalogued id must not become "assume vision".
    const ghost = await ctx.llm.resolveModelInfo('codebuddy', 'ghost-model')
    assert.deepEqual(ghost.inputModalities, ['text'])
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('llm.prepareCall materializes the adapter default output cap', async () => {
  const ctx = await mount()
  try {
    const prepared = await ctx.llm.prepareCall({ provider: 'codebuddy', model: 'hy3' })
    assert.equal(prepared.config.maxTokens, 384_000)
    assert.equal(prepared.adapterDefaults.maxTokens, true)
    assert.deepEqual([...prepared.inputModalities], ['text', 'image'])
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('a text-only turn reaches the wire as a plain chat-completions body', async () => {
  const ctx = await mount()
  try {
    const { body, failure } = await request(ctx, {
      provider: 'codebuddy',
      model: 'hy3',
      messages: [userText('hi')],
    })
    assert.equal(failure, undefined)
    assert.equal(body.model, 'hy3')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    assert.equal(body.stream, true)
    // reasoningEffort "off" is legal in the harness but rejected by the gateway,
    // so it must never appear on the wire.
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal(body.reasoning_effort, undefined)
    assert.equal(body.stream_options, undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('a file block is projected to handle text before the adapter sees it', async () => {
  // New in 0.2.0: ContentBlockMap gained file. The runtime projects every file
  // occurrence to deterministic handle text at the adapter boundary, so the
  // adapter has no file branch - and this proves the projection actually ran
  // instead of the adapter refusing (or flattening away) the block.
  const ctx = await mount()
  try {
    const { body, failure } = await request(ctx, {
      provider: 'codebuddy',
      model: 'hy3',
      messages: [{
        role: 'user',
        content: [{
          type: 'file',
          attachment: { attachmentId: 'sha256:0123456789abcdef', name: 'notes.txt', bytes: 1234 },
        }],
      }],
    })
    assert.equal(failure, undefined, JSON.stringify(failure))
    const content = body.messages[0].content
    assert.equal(typeof content, 'string')
    assert.match(content, /File "notes.txt" \(1234 bytes, sha256:01234567\)/)
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('the runtime strips tool-update developer messages for a route without toolUpdate', async () => {
  // This adapter declares no toolUpdate, so the runtime must project the tool
  // list itself and drop the control messages. If a developer message ever
  // reached the serializer it would (correctly) refuse the request - so a
  // successful request here is the assertion.
  const ctx = await mount()
  try {
    const { body, failure } = await request(ctx, {
      provider: 'codebuddy',
      model: 'hy3',
      messages: [
        userText('hi'),
        { role: 'developer', content: [{ type: 'tool-addition', toolName: 'shot' }] },
      ],
    })
    assert.equal(failure, undefined, JSON.stringify(failure))
    assert.deepEqual(body.messages.map(message => message.role), ['user'])
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('a tool result becomes one wire tool message, paired with its call', async () => {
  const ctx = await mount()
  try {
    const { body, failure } = await request(ctx, {
      provider: 'codebuddy',
      model: 'hy3',
      messages: [
        userText('take a screenshot'),
        {
          role: 'assistant',
          source: { kind: 'model', provider: 'codebuddy', model: 'hy3' },
          content: [{ type: 'tool-call', id: 'call-1', name: 'shot', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
      ],
    })
    assert.equal(failure, undefined, JSON.stringify(failure))
    assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'tool'])
    assert.equal(body.messages[2].tool_call_id, 'call-1')
    assert.equal(body.messages[2].content, 'ok')
    assert.equal(body.messages[1].content, '')
    assert.equal(body.messages[1].tool_calls[0].function.name, 'shot')
  } finally {
    await ctx.fiber.dispose()
  }
})

await check('an image on a text-only route is projected to its placeholder, never dropped', async () => {
  // The measurement says glm-5v-turbo cannot see images. Declaring that makes
  // the runtime substitute a named placeholder instead of dispatching pixels,
  // so the model is told an image existed rather than being asked about one it
  // never received.
  const ctx = await mount()
  try {
    const { body, failure } = await request(ctx, {
      provider: 'codebuddy',
      model: 'glm-5v-turbo',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:0123456789abcdef',
              mediaType: 'image/png',
              bytes: 10,
              width: 4,
              height: 4,
            },
          },
        ],
      }],
    })
    assert.equal(failure, undefined, JSON.stringify(failure))
    const content = body.messages[0].content
    assert.equal(typeof content, 'string')
    assert.match(content, /accepts text only/)
    assert.ok(
      !JSON.stringify(body).includes('image_url'),
      'pixels were dispatched to a text-only model',
    )
  } finally {
    await ctx.fiber.dispose()
  }
})

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed' + String.fromCharCode(10))
process.exit(fail === 0 ? 0 : 1)
