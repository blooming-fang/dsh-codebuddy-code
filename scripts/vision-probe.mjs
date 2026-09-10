/**
 * Measure which CodeBuddy models actually accept IMAGE input.
 *
 * Why this exists: the gateway accepts an OpenAI `image_url` part for every
 * model it serves, so an HTTP 2xx proves nothing about vision. A text-only
 * model answers confidently with a hallucinated description instead of
 * failing. Capability must therefore be measured, not declared — and never
 * inferred from the model name, because `glm-5v-turbo` carries a "V" for
 * vision and is text-only, while `deepseek-v4.1-flash` has no "v" and reads
 * images perfectly.
 *
 * Why the placement is RANDOMIZED and graded BY POSITION: an earlier version
 * asked for "red, green, blue, yellow" in the four quadrants, and text-only
 * models guessed that canonical answer outright — several controls scored 4/4
 * blind, and one model flipped between runs. Merely naming four colours cannot
 * distinguish seeing from guessing. Two changes fix that:
 *   1. the colour-to-quadrant assignment is shuffled per run, so a blind guess
 *      of any fixed order is very unlikely to match;
 *   2. the answer is graded on POSITION — each quadrant's colour must be right
 *      where it actually is — so recall of the palette is worth nothing.
 * The no-image control must FAIL for a verdict to count; a model that scores
 * anyway is reported INCONCLUSIVE rather than credited.
 *
 * Usage:
 *   node scripts/vision-probe.mjs                 # probe the built-in catalog
 *   node scripts/vision-probe.mjs glm-5.2 hy3     # probe specific models
 *   node scripts/vision-probe.mjs --trials=3      # repeat each model (recommended)
 *
 * Sampling is not deterministic: a borderline model can flip between runs, so
 * a single trial is weak evidence. `--trials=N` repeats the image turn on a
 * FRESH shuffled layout each time and credits vision only on a strict majority,
 * which is what the shipped catalog was measured with. Exit code is 0 when
 * every probed model is classifiable, 1 otherwise, so it can gate a catalog
 * edit.
 */
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENDPOINT = process.env.CODEBUDDY_ENDPOINT ?? 'https://copilot.tencent.com/v2/chat/completions'
const TOKEN_FILE = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info')

/** Encode a 24-bit RGB PNG from a pixel function, with no image dependencies. */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // per-scanline filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      offset += 3
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The palette a probe run draws from. Positions are shuffled per run. */
const PALETTE = [
  { name: 'red', rgb: [255, 0, 0] },
  { name: 'green', rgb: [0, 255, 0] },
  { name: 'blue', rgb: [0, 0, 255] },
  { name: 'yellow', rgb: [255, 255, 0] },
]
/** Quadrant labels in reading order, the order the answer must follow. */
const QUADRANT_LABELS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
/**
 * Positionally correct quadrants required to credit vision. Three of four
 * tolerates one misread or one formatting slip while still being far beyond
 * what a blind guess achieves on a shuffled layout (1/4 by chance).
 */
const VISION_THRESHOLD = 3
/**
 * Output cap per turn. Generous because several models emit the real answer
 * only after a long `reasoning_content` preamble even with thinking disabled;
 * a tight cap truncates the answer to "" and makes a seeing model look blind.
 */
const MAX_TOKENS = 400

/**
 * Build one probe: a shuffled quadrant image plus the answer key.
 *
 * Shuffling is the whole point. With a fixed layout, a text-only model that
 * guesses the canonical "red, green, blue, yellow" scores full marks blind
 * (observed: several controls at 4/4). A fresh permutation per run makes a
 * lucky blind guess unlikely, and position-grading means the model must place
 * each colour where it actually is.
 *
 * @returns the PNG bytes, the expected colours in reading order, and the layout.
 */
function makeProbe() {
  const colours = [...PALETTE]
  for (let i = colours.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[colours[i], colours[j]] = [colours[j], colours[i]]
  }
  // Quadrant order: [TL, TR, BL, BR]
  const png = encodePng(128, 128, (x, y) => {
    const column = x < 64 ? 0 : 1
    const row = y < 64 ? 0 : 1
    return colours[row * 2 + column].rgb
  })
  return {
    png,
    expected: colours.map(colour => colour.name),
    layout: QUADRANT_LABELS.map((label, index) => `${label}=${colours[index].name}`).join(' '),
  }
}

/** Parse an answer into four positional colour words, or null when unparseable. */
function parseAnswer(answer) {
  const words = answer.toLowerCase().match(/red|green|blue|yellow/g)
  return words === null || words.length < 4 ? null : words.slice(0, 4)
}

/**
 * Count positionally correct quadrants.
 * A model that names the right palette in the wrong places scores 0, which is
 * exactly the distinction the old "names four colours" check could not make.
 */
function scorePositions(answer, expected) {
  const said = parseAnswer(answer)
  if (said === null) return 0
  return said.filter((colour, index) => colour === expected[index]).length
}

/** Read the bearer session the adapter itself would use. */function readSession() {
  const local = process.env.LOCALAPPDATA
  const base = local !== undefined && local.length > 0 ? local : join(homedir(), 'AppData', 'Local')
  const login = JSON.parse(readFileSync(join(base, TOKEN_FILE), 'utf8'))
  if (typeof login.auth?.accessToken !== 'string' || login.auth.accessToken.length === 0) {
    throw new Error(`no access token in ${join(base, TOKEN_FILE)}; log in with the CodeBuddy desktop app`)
  }
  return {
    accessToken: login.auth.accessToken,
    ...(typeof login.account?.uid === 'string' ? { userId: login.account.uid } : {}),
    ...(typeof login.auth.domain === 'string' ? { domain: login.auth.domain } : {}),
  }
}

/** Send one turn and collect its visible SSE text. */
async function ask(model, session, content) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      // The gateway blocks a `deepseek-harness` user-agent; stay neutral.
      'user-agent': 'codebuddy-dsh',
      ...(session.userId === undefined ? {} : { 'x-user-id': session.userId }),
      ...(session.domain === undefined ? {} : { 'x-domain': session.domain }),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      stream: true,
      // Generous on purpose. Several models emit the answer only after a long
      // `reasoning_content` preamble even with thinking disabled, so a small cap
      // truncates the REAL answer to "" and the model looks text-only when it is
      // not — this is how `glm-5.0-turbo` was mis-measured as blind.
      max_tokens: MAX_TOKENS,
      thinking: { type: 'disabled' },
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, status: response.status, detail: detail.slice(0, 200) }
  }
  const payloadText = await response.text()
  const deltas = []
  for (const line of payloadText.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') break
    try {
      // Visible text only: `reasoning_content` is the model's scratchpad, not
      // its answer, and grading it would credit private deliberation.
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content
      if (typeof delta === 'string') deltas.push(delta)
    } catch {
      // A malformed chunk cannot change the verdict; keep scanning.
    }
  }
  return { ok: true, status: response.status, answer: deltas.join('').trim() }
}

const PROMPT = 'Look at this image. It is split into four equal quadrants. Reply with ONLY the'
  + ' four colour words for top-left, top-right, bottom-left, bottom-right, comma-separated.'
  + ' No explanation.'

const argv = process.argv.slice(2)
const session = readSession()
/** How many fresh-layout image trials each model gets. */
const TRIALS = (() => {
  const flag = argv.find(arg => arg.startsWith('--trials='))
  if (flag === undefined) return 1
  const value = Number(flag.slice('--trials='.length))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('--trials must be a positive integer')
  return value
})()

/**
 * The models to probe: explicit args, or the ids this plugin ships.
 *
 * The shipped ids are read from the real schema when the plugin's peer
 * dependencies resolve. A bare source checkout has no `node_modules`, so fall
 * back to scraping the `DEFAULT_MODELS` ids out of `src/index.js` — this only
 * affects which ids the no-argument form probes, never the verdict.
 */
async function resolveTargets() {
  const explicit = argv.filter(arg => !arg.startsWith('--'))
  if (explicit.length > 0) return explicit
  const entry = new URL('../src/index.js', import.meta.url)
  try {
    const { Config } = await import(entry.href)
    return Config({}).models.map(model => model.id)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    const source = readFileSync(entry, 'utf8')
    const block = source.slice(source.indexOf('const DEFAULT_MODELS = ['))
    const ids = [...block.slice(0, block.indexOf('\n].map')).matchAll(/\{ id: '([^']+)'/g)]
      .map(match => match[1])
    if (ids.length === 0) throw new Error('could not read DEFAULT_MODELS ids; pass model ids explicitly')
    console.log('(plugin deps unresolved: probing the DEFAULT_MODELS ids read from source)')
    return ids
  }
}

const targets = await resolveTargets()
console.log(`probing ${targets.length} model(s) against ${ENDPOINT}`)
console.log(`graded BY POSITION on a shuffled layout, ${TRIALS} image trial(s) each; the no-image control must fail\n`)

let unresolved = 0
const gradedVision = []
const gradedTextOnly = []
for (const model of targets) {
  // The control runs once: it measures the model's blind-guess rate, which does
  // not depend on the layout being probed.
  const controlProbe = makeProbe()
  const withoutImage = await ask(model, session, PROMPT)
  const controlScore = withoutImage.ok
    ? scorePositions(withoutImage.answer, controlProbe.expected)
    : -1

  const trials = []
  let lastProbe = controlProbe
  let unserved
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const probe = makeProbe()
    lastProbe = probe
    const withImage = await ask(model, session, [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${probe.png.toString('base64')}` } },
    ])
    if (!withImage.ok) {
      unserved = withImage
      break
    }
    trials.push({
      probe,
      answer: withImage.answer,
      score: scorePositions(withImage.answer, probe.expected),
    })
  }

  const hits = trials.filter(trial => trial.score >= VISION_THRESHOLD).length
  const majority = hits * 2 > TRIALS
  let verdict
  if (unserved !== undefined) {
    verdict = `UNSERVED (HTTP ${unserved.status})`
    unresolved += 1
  } else if (majority && controlScore < VISION_THRESHOLD) {
    // Placed the shuffled layout correctly in most trials AND could not do it
    // blind: the only combination that demonstrates real vision.
    verdict = 'VISION'
    gradedVision.push(model)
  } else if (majority) {
    // Scored with the image but ALSO placed correctly blind, so the control
    // failed to separate seeing from guessing. Re-run rather than credit it.
    verdict = 'INCONCLUSIVE (control also placed correctly)'
    unresolved += 1
  } else if (controlScore >= VISION_THRESHOLD) {
    verdict = 'INCONCLUSIVE (control guesses well, no vision seen)'
    unresolved += 1
  } else {
    verdict = 'TEXT-ONLY'
    gradedTextOnly.push(model)
  }

  const scores = trials.map(trial => trial.score).join('/')
  console.log(`${verdict.padEnd(40)} ${model}  (trials ${scores || '-'} of 4, control ${controlScore}/4)`)
  console.log(`    layout: ${lastProbe.layout}`)
  const sample = trials.at(-1)
  if (sample !== undefined) console.log(`    with image: ${JSON.stringify(sample.answer.slice(0, 140))}`)
  else console.log(`    ${unserved.detail}`)
}

// Emit the exact edit a maintainer needs, so the measured set cannot drift.
console.log(`\nVISION_MODEL_IDS (${gradedVision.length}) -> paste into src/index.js:`)
for (const id of gradedVision) console.log(`  '${id}',`)
console.log(`\nleft text-only (${gradedTextOnly.length}): ${gradedTextOnly.join(', ') || '(none)'}`)
process.exit(unresolved === 0 ? 0 : 1)
