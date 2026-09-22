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

const { Config, isVolatileField, plainOptions, resolveAdapterOptions } = await import('../src/index.js')
const { serializeMessages, serializeRequest } = await import('../src/serialize.js')
const { CodeBuddyAdapter } = await import('../src/adapter.js')
// Runtime-only helpers; imported for the durable-offload cases.
const { IMAGE_OFFLOAD_REQUIRED_CODE, offloadedImageText, projectOffloadedImages } =
  await import('@deepseek-ai/dsh-llm')
const { requestImageDimensions } = await import('@deepseek-ai/dsh-attachment')

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
// dsh 0.1.7 parses every `\`.volatile()\`` field to a live reference the Loader
// commits in place, so the parsed section is read through `plainOptions`.
check('every Config field is volatile, the only editable kind in dsh 0.1.7', () => {
  // Two independent halves of the same contract. `SettingsForms.volatileForm`
  // and `isVolatilePath` read the SCHEMA meta; the Loader's `volatileEntries`
  // reads the PARSED value marker. A field missing either half is uneditable.
  for (const [key, field] of Object.entries(Config.dict)) {
    assert.equal(field.meta.volatile, true, `Config schema field "${key}" must declare .volatile()`)
  }
  const parsed = Config({})
  for (const [key, value] of Object.entries(parsed)) {
    assert.ok(isVolatileField(value), `Config field "${key}" must parse to a volatile reference`)
  }
  // The bug this pins: SettingsForms.write() throws "has no volatile fields"
  // for an entry whose schema declares none, so a non-volatile Config is
  // silently unconfigurable rather than broken loudly.
  assert.deepEqual(Object.keys(plainOptions(parsed)).sort(), Object.keys(parsed).sort())
})
check('an empty section resolves with text-only defaults', () => {
  const value = plainOptions(Config({}))
  assert.deepEqual(value.defaultInput, ['text'])
  assert.equal(value.imagePixelBudget, 640000)
  assert.equal(value.imageMaxBytes, 1048576)
})
// The shipped output cap is deliberately generous (the reference client's own
// 4,096 truncated real answers that arrived after a long `reasoning_content`
// preamble). Pin it: nothing else in this suite reads the default, so a silent
// revert would otherwise pass unnoticed. Precedence stays explicit-value-wins.
check('the default output cap is 384000, and an explicit value still wins', () => {
  assert.equal(plainOptions(Config({})).maxTokens, 384_000)
  assert.equal(resolveAdapterOptions({}).maxTokens, 384_000)
  assert.equal(resolveAdapterOptions({ maxTokens: 8192 }).maxTokens, 8192)
  const capped = resolveAdapterOptions({ models: [{ id: 'capped', maxTokens: 512 }] })
  assert.equal(capped.models[0].maxTokens, 512)
  assert.equal(capped.maxTokens, 384_000)
})
check('the built-in catalog survives the schema with modalities intact', () => {
  const byId = new Map(plainOptions(Config({})).models.map(m => [m.id, m]))
  assert.deepEqual(byId.get('deepseek-v4.1-flash').inputModalities, ['text', 'image'])
  assert.deepEqual(byId.get('glm-5v-turbo').inputModalities, ['text'])
})
check('a trailing-comma maxTokens is rejected by the schema, not silently kept', () => {
  // The exact typo that silently reverted a real settings section to defaults.
  assert.throws(() => Config({ maxTokens: '177824,' }), /expected number/)
})
check('per-model image budgets flow into the resolved catalog', () => {
  const resolved = resolveAdapterOptions(plainOptions(Config({
    models: [{ id: 'vlm', inputModalities: ['text', 'image'], imageMaxBytes: 500000 }],
  })))
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
// dsh 0.1.7 made a tool result a first-class `role: 'tool'` message
// (toolCallId + content), replacing the `tool-result` block that used to be
// nested inside a user message. Reading the old shape left the image
// uncollected, `useParts` false, and the whole result re-emitted as a user
// message — the regression these cases pin.
check('a tool message becomes one wire tool message', () => {
  const wire = serializeMessages([{
    role: 'tool',
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'screenshot' }],
  }], undefined)
  assert.equal(wire.length, 1)
  assert.equal(wire[0].role, 'tool')
  assert.equal(wire[0].tool_call_id, 'call-1')
  assert.equal(wire[0].content, 'screenshot')
})
check('a tool message never becomes a user message', () => {
  const wire = serializeMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'shot', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
  ], undefined)
  assert.deepEqual(wire.map(m => m.role), ['assistant', 'tool'])
  assert.equal(wire.filter(m => m.role === 'user').length, 0)
})
check('an empty tool result still carries content', () => {
  const wire = serializeMessages([{ role: 'tool', toolCallId: 'call-1', content: [] }], undefined)
  assert.equal(wire[0].content, '(no output)')
})
check('a tool result image moves to a following user message', () => {
  const wire = serializeMessages([{
    role: 'tool',
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'screenshot' }, imageBlock('att1')],
  }], prepared())
  const tool = wire.find(m => m.role === 'tool')
  const carrier = wire.find(m => m.role === 'user')
  assert.equal(tool.content, 'screenshot')
  assert.ok(carrier.content.some(p => p.type === 'image_url'))
  // The carrier must FOLLOW the tool message: a user message in between would
  // break the call/result pairing the gateway validates.
  assert.ok(wire.indexOf(tool) < wire.indexOf(carrier))
})
check('a tool image is prepared, not silently dropped, on an image route', () => {
  // The exact 0.1.7 regression: a flat `contentHasImage` walk must still see
  // the tool message's own image, or the text join erases it.
  const wire = serializeMessages([{
    role: 'tool',
    toolCallId: 'call-1',
    content: [imageBlock('att1')],
  }], prepared())
  assert.equal(wire[0].content, '(no output)')
  assert.equal(wire[1].role, 'user')
  assert.ok(wire[1].content.some(p => p.type === 'image_url'))
})
check('a developer message is refused, not mis-serialized as a user turn', () => {
  assert.throws(
    () => serializeMessages([{ role: 'developer', content: [{ type: 'text', text: 'x' }] }], undefined),
    /cannot represent a developer message/,
  )
})
check('tool-change blocks are refused', () => {
  assert.throws(
    () => serializeMessages([{
      role: 'user',
      content: [{ type: 'tool-addition', toolName: 'shot' }],
    }], undefined),
    /cannot represent tool-change blocks/,
  )
})
check('an unknown user block is refused rather than dropped', () => {
  assert.throws(
    () => serializeMessages([{ role: 'user', content: [{ type: 'mystery' }] }], undefined),
    /cannot represent mystery content/,
  )
})
check('serializeRequest stays text-only without images', () => {
  const body = serializeRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, {})
  assert.equal(body.messages[0].content, 'x')
  assert.equal(body.stream, true)
})

console.log('\n== durable offload projection ==')
check('an offloaded occurrence becomes placeholder text, not a silent drop', () => {
  // Offloading is a durable surface decision now: the adapter substitutes text
  // for an occurrence the session already marked, and never drops one itself.
  const offloaded = projectOffloadedImages(
    [{ role: 'user', content: [{ ...imageBlock('big'), offloaded: true }] }],
    ref => offloadedImageText(ref, undefined),
  )
  const text = offloaded[0].content.filter(b => b.type === 'text').map(b => b.text).join('')
  assert.match(text, /image omitted to fit request image limits/)
  // With no image left, the serializer keeps the placeholder on the string form.
  const wire = serializeMessages(offloaded, undefined)
  assert.equal(typeof wire[0].content, 'string')
  assert.match(wire[0].content, /image omitted to fit request image limits/)
})

console.log('\n== adapter capability gate ==')
/** A stub durable attachment service recording every request target it is asked for. */
const stubAttachments = (version, targets = []) => ({
  targets,
  readImageRequest: async (_ref, target) => {
    targets.push(target)
    return version
  },
})

const makeAdapter = (models, { attachments } = {}) => new CodeBuddyAdapter({
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
  resolveAttachments: () => attachments,
  resolveImageAccess: () => undefined,
})

const collect = async (iter) => { const out = []; for await (const c of iter) out.push(c); return out }
const runStream = async (adapter, messages) => {
  try {
    const chunks = await collect(adapter.stream({ model: 'plain', messages, purpose: 'conversation' }))
    return { failure: chunks.find(c => c.type === 'finish' && c.reason?.kind === 'error') }
  } catch (error) {
    return { code: error.code, message: error.message, failure: error.failure }
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
    { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } },
  ])
  assert.equal(price.visualTokens, 0)
  assert.match(price.text, /text only/)
})
check('imageRequestPricing charges visual tokens for a retained vision-route occurrence', () => {
  const adapter = makeAdapter([{ id: 'vision', inputModalities: ['text', 'image'] }])
  const [price] = adapter.imageRequestPricing('codebuddy', 'vision').priceImages([
    { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 800, height: 800 } },
  ])
  assert.ok(price.visualTokens > 0)
})
check('imageRequestPricing prices a durably offloaded occurrence as its placeholder', () => {
  // Pricing must reproduce the projection from durable metadata alone: an
  // occurrence the surface marked offloaded spends no visual tokens.
  const adapter = makeAdapter([{ id: 'vision', inputModalities: ['text', 'image'] }])
  const [price] = adapter.imageRequestPricing('codebuddy', 'vision').priceImages([
    {
      type: 'image',
      offloaded: true,
      attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 800, height: 800 },
    },
  ])
  assert.equal(price.visualTokens, 0)
  assert.match(price.text, /image omitted to fit request image limits/)
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

// dsh 0.1.6-alpha.1 moved request-target resolution to the adapter: the
// attachment service now receives an exact {width,height,maxBytes} target
// instead of the old {maxPixels,maxBytes} policy object.
check('a retained image is prepared at an exact request target', async () => {
  const version = { mediaType: 'image/png', data: Uint8Array.from([1]), bytes: 3, width: 8, height: 8 }
  const store = stubAttachments(version)
  const result = await runStream(makeAdapter([{ id: 'plain', inputModalities: ['text', 'image'] }], {
    attachments: store,
  }), [{ role: 'user', content: [imageBlock('a1')] }])
  const [target] = store.targets
  assert.deepEqual(Object.keys(target).sort(), ['height', 'maxBytes', 'width'])
  assert.equal(target.maxBytes, 1048576)
  const expected = requestImageDimensions(10, 10, 640000)
  assert.deepEqual({ width: target.width, height: target.height }, expected)
  // It got PAST preparation and failed on the unroutable host instead.
  assert.ok(!/could not be prepared/.test(JSON.stringify(result)))
})

check('an over-budget retained image asks for durable offload, not a silent drop', async () => {
  // 128 MiB raw is ~178 MiB base64, past the route's 128 MiB accumulated bound.
  const version = { mediaType: 'image/png', data: Uint8Array.from([1]), bytes: 128 * 1024 * 1024, width: 8, height: 8 }
  const result = await runStream(makeAdapter([{ id: 'plain', inputModalities: ['text', 'image'] }], {
    attachments: stubAttachments(version),
  }), [{ role: 'user', content: [imageBlock('a1')] }])
  assert.equal(result.code, IMAGE_OFFLOAD_REQUIRED_CODE, JSON.stringify(result))
  assert.equal(result.failure?.offloadImages, 1)
  assert.ok(!/TRANSPORT|fetch failed|ENOTFOUND|EAI_AGAIN/.test(JSON.stringify(result)), 'dispatched to network')
})

check('a retained image with no mounted attachment service fails loudly', async () => {
  const result = await runStream(makeAdapter([{ id: 'plain', inputModalities: ['text', 'image'] }]), [{
    role: 'user',
    content: [imageBlock('a1')],
  }])
  assert.match(JSON.stringify(result), /mount the durable attachment service/)
  assert.ok(!/TRANSPORT|fetch failed|ENOTFOUND|EAI_AGAIN/.test(JSON.stringify(result)), 'dispatched to network')
})

check('a vision model with an image passes the gate', async () => {
  const result = await runStream(makeAdapter([{ id: 'plain', inputModalities: ['text', 'image'] }], {
    attachments: stubAttachments({ mediaType: 'image/png', data: Uint8Array.from([1]), bytes: 3, width: 8, height: 8 }),
  }), [{
    role: 'user',
    content: [{ type: 'text', text: 'look' }, imageBlock('a1')],
  }])
  // It will fail on transport (unroutable host), which proves it got PAST the gate.
  assert.ok(!/not configured to accept image input/.test(JSON.stringify(result)))
})

console.log('\n== plugin wiring (apply) ==')
// dsh 0.1.7 replaced SettingsForms.installSection with a Config whose fields are
// \`.volatile()\` live references the Loader commits in place, plus
// \`settings.configure\` for page policy. This exercises the real \`apply\` against a
// fake context, so a wrong wiring (a missing effect, a stale snapshot, a route
// that never re-registers) fails here instead of in the running GUI.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const harnessFor = (config) => {
  const seen = { providers: [], adapters: [], configured: [], replaced: 0, effects: [] }
  const child = {
    effect: (fn) => { seen.effects.push(fn()) },
    settings: {
      configure: (policy, owner) => { seen.configured.push({ policy, owner }); return () => {} },
    },
  }
  const ctx = {
    logger: { error: () => {}, warn: () => {}, debug: () => {}, info: () => {} },
    get: () => undefined,
    fiber: { id: 'plugin-fiber' },
    llm: {
      registerConfigurableProviders: (entries) => seen.providers.push(...entries),
      registerAdapter: (names, adapter) => {
        seen.adapters.push({ names, adapter })
        const handle = () => {}
        handle.replace = () => { seen.replaced += 1 }
        return handle
      },
    },
    inject: (deps, callback) => callback(child),
  }
  return { ctx, config, seen }
}

check('apply wires the route, the Models page card, and the page policy', async () => {
  const { apply, PROVIDER } = await import('../src/index.js')
  const { ctx, config, seen } = harnessFor(Config({}))
  apply(ctx, config)
  assert.equal(seen.providers.length, 1)
  assert.deepEqual(seen.providers[0], {
    provider: PROVIDER,
    displayName: 'CodeBuddy',
    settingsNs: 'llm-codebuddy',
    settingsPath: [],
  })
  assert.deepEqual(seen.adapters[0].names, [PROVIDER])
  assert.equal(typeof seen.adapters[0].adapter.stream, 'function')
  assert.deepEqual(seen.configured[0].policy, { auto: false })
  assert.equal(seen.configured[0].owner, ctx.fiber)
  assert.equal(seen.effects.length, 1)
})

check('a live settings edit reaches the next operation without a remount', async () => {
  const { apply, PROVIDER } = await import('../src/index.js')
  const { ctx, config, seen } = harnessFor(Config({}))
  apply(ctx, config)
  const adapter = seen.adapters[0].adapter
  assert.equal((await adapter.resolveModel(PROVIDER, 'anything')).defaultMaxTokens, 384_000)
  // Exactly what the Loader does to a volatile field on an edit: commit a new
  // value into the SAME reference the parsed config already holds.
  config.maxTokens[VOLATILE_WRITE](8192)
  assert.equal((await adapter.resolveModel(PROVIDER, 'anything')).defaultMaxTokens, 8192)
})

check('a retry-policy change re-registers the route in place', async () => {
  const { apply, PROVIDER } = await import('../src/index.js')
  const { ctx, config, seen } = harnessFor(Config({}))
  apply(ctx, config)
  const adapter = seen.adapters[0].adapter
  // Unchanged: no churn on the ordinary path.
  await adapter.listModels(PROVIDER)
  assert.equal(seen.replaced, 0)
  config.retryPolicy[VOLATILE_WRITE]({ attempts: 3 })
  await adapter.listModels(PROVIDER)
  assert.equal(seen.replaced, 1)
  // Idempotent: the same policy does not re-register again.
  await adapter.listModels(PROVIDER)
  assert.equal(seen.replaced, 1)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
