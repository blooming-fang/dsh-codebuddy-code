/**
 * Regression tests for per-model image input.
 *
 * These run against this package's own `src/`, so they need the peer
 * dependencies resolvable — i.e. run them from an INSTALLED profile copy
 * (`$DSH_HOME/profiles/web/node_modules/dsh-codebuddy-code`), not from a bare
 * source checkout, which has no `node_modules`:
 *
 *   node tests/image-support.test.mjs
 *
 * They are offline: no network and no CodeBuddy login required. The live
 * capability measurement lives in `scripts/vision-probe.mjs` instead.
 */
import assert from 'node:assert/strict'

const { Config, resolveAdapterOptions } = await import('../src/index.js')
const { serializeMessages, serializeRequest } = await import('../src/serialize.js')
const { CodeBuddyAdapter } = await import('../src/adapter.js')
// Runtime-only helper; imported for the offloading cases.
const { offloadRequestImagesWithPolicy, offloadedImageText } = await import('@deepseek-ai/dsh-llm')

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
    pass += 1
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`)
    fail += 1
  }
}

const imageBlock = attachmentId => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', bytes: 100, width: 10, height: 10 },
})
const version = { mediaType: 'image/png', data: Uint8Array.from([1, 2, 3]), width: 8, height: 8, bytes: 3 }
const prepared = (id = 'att1') => ({ requestImages: new Map([[id, version]]), resolveAccess: () => undefined })

console.log('\n== catalog modality resolution ==')
check('measured vision models declare text+image', () => {
  const byId = new Map(resolveAdapterOptions({}).models.map(m => [m.id, m]))
  assert.deepEqual(byId.get('deepseek-v4.1-flash').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('glm-5.2').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('kimi-k2.5').inputModalities, ['text', 'image'])
})
check('glm-5v-turbo is text-only despite the "V" in its name', () => {
  const m = resolveAdapterOptions({}).models.find(e => e.id === 'glm-5v-turbo')
  assert.deepEqual(m.inputModalities, ['text'])
  assert.equal(m.imagePixelBudget, undefined)
})
check('vision is the measured norm: only the deny-list is text-only', () => {
  const textOnly = resolveAdapterOptions({}).models
    .filter(m => !m.inputModalities.includes('image')).map(m => m.id)
  assert.deepEqual(textOnly.sort(), ['glm-4.7', 'glm-5v-turbo'])
})
check('an entry without inputModalities inherits defaultInput', () => {
  const o = resolveAdapterOptions({ models: [{ id: 'custom-vlm' }], defaultInput: ['text', 'image'] })
  assert.deepEqual(o.models[0].inputModalities, ['text', 'image'])
})
check('defaultInput defaults to text-only so an unknown model cannot hallucinate', () => {
  assert.deepEqual(resolveAdapterOptions({ models: [{ id: 'mystery' }] }).models[0].inputModalities, ['text'])
})
check('an explicit per-model list beats the connection default', () => {
  const o = resolveAdapterOptions({
    models: [{ id: 'a', inputModalities: ['text'] }, { id: 'b' }],
    defaultInput: ['text', 'image'],
  })
  assert.deepEqual(o.models[0].inputModalities, ['text'])
  assert.deepEqual(o.models[1].inputModalities, ['text', 'image'])
})
check('rejects an unknown modality', () => {
  assert.throws(
    () => resolveAdapterOptions({ models: [{ id: 'x', inputModalities: ['audio'] }] }),
    /must contain only "text" and "image"/,
  )
})
check('rejects duplicate modalities', () => {
  assert.throws(
    () => resolveAdapterOptions({ models: [{ id: 'x', inputModalities: ['text', 'text'] }] }),
    /must not contain duplicates/,
  )
})
check('rejects image limits on a text-only model', () => {
  assert.throws(
    () => resolveAdapterOptions({ models: [{ id: 'x', inputModalities: ['text'], imageMaxBytes: 10 }] }),
    /cannot declare image request limits/,
  )
})
check('rejects an empty defaultInput', () => {
  assert.throws(() => resolveAdapterOptions({ defaultInput: [] }), /defaultInput must name at least one modality/)
})
check('an empty inputModalities list means "unspecified", not an error', () => {
  // Schemastery materializes an absent key as `[]`; a `.min(1)` here would make
  // every catalog entry that omits the key fail schema resolution.
  const o = resolveAdapterOptions({ models: [{ id: 'blank', inputModalities: [] }], defaultInput: ['text', 'image'] })
  assert.deepEqual(o.models[0].inputModalities, ['text', 'image'])
})

console.log('\n== Config schema (as the settings pipeline applies it) ==')
check('an empty section resolves with text-only defaults', () => {
  const value = Config({})
  assert.deepEqual(value.defaultInput, ['text'])
  assert.equal(value.imagePixelBudget, 640000)
  assert.equal(value.imageMaxBytes, 1048576)
})
check('the built-in catalog survives the schema with modalities intact', () => {
  const byId = new Map(Config({}).models.map(m => [m.id, m]))
  assert.deepEqual(byId.get('deepseek-v4.1-flash').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('glm-5v-turbo').inputModalities, ['text'])
})
check('a trailing-comma maxTokens is rejected by the schema, not silently kept', () => {
  // The exact typo that silently reverted a real settings section to defaults.
  assert.throws(() => Config({ maxTokens: '177824,' }), /expected number/)
})
check('per-model image budgets flow into the resolved catalog', () => {
  const resolved = resolveAdapterOptions(Config({
    models: [{ id: 'vlm', inputModalities: ['text', 'image'], imageMaxBytes: 500000 }],
  }))
  assert.equal(resolved.models[0].imageMaxBytes, 500000)
  assert.equal(resolved.imagePixelBudget, 640000)
})

console.log('\n== serializer: image parts ==')
check('a text-only user message stays a plain string', () => {
  const wire = serializeMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], undefined)
  assert.equal(wire[0].content, 'hi')
})
check('an image forces content parts with a data URL and a handle', () => {
  const wire = serializeMessages(
    [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, imageBlock('att1')] }],
    prepared(),
  )
  const parts = wire[0].content
  assert.ok(Array.isArray(parts), 'expected content parts')
  assert.equal(parts[0].text, 'what is this')
  assert.match(parts[1].text, /Image /)
  assert.equal(parts[2].type, 'image_url')
  assert.equal(parts[2].image_url.url, 'data:image/png;base64,AQID')
})
check('the internal imageHandle marker never reaches the wire', () => {
  const wire = serializeMessages([{ role: 'user', content: [imageBlock('att1')] }], prepared())
  for (const part of wire[0].content) assert.equal(part.imageHandle, undefined)
})
check('an unprepared image reference fails loudly', () => {
  assert.throws(
    () => serializeMessages([{ role: 'user', content: [imageBlock('missing')] }], { requestImages: new Map() }),
    /could not be prepared/,
  )
})
check('an image with NO prepared versions still fails loudly, not silently', () => {
  // The dangerous shape: the caller passed no `images` at all. A text join here
  // would erase the image and the model would answer about an image it never saw.
  assert.throws(
    () => serializeMessages([{ role: 'user', content: [imageBlock('missing')] }], undefined),
    /could not be prepared/,
  )
})
check('rejects an image in an assistant message', () => {
  assert.throws(
    () => serializeMessages([{ role: 'assistant', content: [imageBlock('a')] }], undefined),
    /cannot represent image content in a assistant message/,
  )
})
check('a tool result image moves to a following user message', () => {
  const wire = serializeMessages([{
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'screenshot' }, imageBlock('att1')],
    }],
  }], prepared())
  const tool = wire.find(m => m.role === 'tool')
  const carrier = wire.find(m => m.role === 'user')
  assert.equal(tool.content, 'screenshot')
  assert.ok(carrier.content.some(p => p.type === 'image_url'))
})
check('serializeRequest stays text-only without images', () => {
  const body = serializeRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, {})
  assert.equal(body.messages[0].content, 'x')
  assert.equal(body.stream, true)
})

console.log('\n== request-limit offloading ==')
check('an over-budget image becomes placeholder text, not a silent drop', () => {
  const big = {
    type: 'image',
    attachment: { attachmentId: 'big', mediaType: 'image/png', bytes: 5_000_000, width: 10, height: 10 },
  }
  const offloaded = offloadRequestImagesWithPolicy([{ role: 'user', content: [big] }], {
    representation: 'base64',
    maxBytes: 1_000_000,
    byteQuantum: 1,
    countQuantum: 1,
    placeholder: ref => offloadedImageText(ref, undefined),
  })
  const text = offloaded[0].content.filter(b => b.type === 'text').map(b => b.text).join('')
  assert.match(text, /image omitted to fit request image limits/)
  // With no image left, the serializer keeps the placeholder on the string form.
  const wire = serializeMessages(offloaded, undefined)
  assert.equal(typeof wire[0].content, 'string')
  assert.match(wire[0].content, /image omitted to fit request image limits/)
})

console.log('\n== adapter capability gate ==')
const makeAdapter = (models) => new CodeBuddyAdapter({
  options: () => ({
    endpoint: 'https://example.invalid',
    models,
    defaults: { reasoningEffort: 'off' },
    maxTokens: 1024,
    defaultContextWindow: 1000,
    imagePixelBudget: 640000,
    imageMaxBytes: 1048576,
    streamIdleTimeoutMs: 1000,
    retryPolicy: {},
  }),
  resolveSession: async () => ({ accessToken: 't' }),
  resolveAttachments: () => undefined,
  resolveImageAccess: () => undefined,
})

const collect = async (iter) => { const out = []; for await (const c of iter) out.push(c); return out }
const runStream = async (adapter, messages) => {
  try {
    const chunks = await collect(adapter.stream({ model: 'plain', messages, purpose: 'conversation' }))
    return { failure: chunks.find(c => c.type === 'finish' && c.reason?.kind === 'error') }
  } catch (error) {
    return { code: error.code, message: error.message }
  }
}

check('listModels reports per-model modalities', async () => {
  const models = await makeAdapter([
    { id: 'vision', inputModalities: ['text', 'image'] },
    { id: 'plain', inputModalities: ['text'] },
  ]).listModels('codebuddy')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
})
check('an uncatalogued model declares text-only', async () => {
  const info = await makeAdapter([]).resolveModel('codebuddy', 'ghost')
  assert.deepEqual(info.inputModalities, ['text'])
})
check('imageRequestPricing prices a text-only route as placeholder text', () => {
  const adapter = makeAdapter([{ id: 'plain', inputModalities: ['text'] }])
  const [price] = adapter.imageRequestPricing('codebuddy', 'plain').priceImages([
    { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 },
  ])
  assert.equal(price.visualTokens, 0)
  assert.match(price.text, /text only/)
})
check('imageRequestPricing charges visual tokens for a vision route', () => {
  const adapter = makeAdapter([{ id: 'vision', inputModalities: ['text', 'image'] }])
  const [price] = adapter.imageRequestPricing('codebuddy', 'vision').priceImages([
    { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 800, height: 800 },
  ])
  assert.ok(price.visualTokens > 0)
})

// The gate must reject BEFORE dispatch: the endpoint is unroutable, so a
// transport error instead of the capability error would mean we sent it anyway.
check('a text-only model rejects an image before dispatch', async () => {
  const result = await runStream(makeAdapter([{ id: 'plain', inputModalities: ['text'] }]), [{
    role: 'user',
    content: [{ type: 'text', text: 'look' }, imageBlock('a1')],
  }])
  const detail = JSON.stringify(result)
  assert.match(detail, /not configured to accept image input/, `expected capability rejection, got ${detail}`)
  assert.ok(!/TRANSPORT|fetch failed|ENOTFOUND|EAI_AGAIN/.test(detail), `dispatched to network: ${detail}`)
})

check('a vision model with an image passes the gate', async () => {
  const result = await runStream(makeAdapter([{ id: 'plain', inputModalities: ['text', 'image'] }]), [{
    role: 'user',
    content: [{ type: 'text', text: 'look' }, imageBlock('a1')],
  }])
  // It will fail on transport (unroutable host), which proves it got PAST the gate.
  assert.ok(!/not configured to accept image input/.test(JSON.stringify(result)))
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
