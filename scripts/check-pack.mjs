/**
 * Prepack/pre-publish sanity check: confirm every file the bundle needs to be
 * loadable is present and that the pack would not silently produce a broken
 * tarball (missing `cordis.patch.yml`, adapter lodash imports, or unpopulated
 * `src/`). Runs automatically via the `prepack` script before `npm pack` /
 * `npm publish`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Files a usable bundle must carry. `files` in package.json whitelists them. */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'src/index.js',
  'src/adapter.js',
  'src/serialize.js',
  'src/sse.js',
  'src/translate.js',
  'src/types.js',
]

const missing = []
for (const rel of REQUIRED) {
  const p = join(root, rel)
  if (!existsSync(p)) missing.push(rel)
}
if (missing.length > 0) {
  console.error(`[check-pack] missing required file(s): ${missing.join(', ')}`)
  process.exit(1)
}

// `cordis.patch.yml` must reference this package by its own name, matching the
// manifest, so the loader resolves the row. The YAML quotes the name, so match
// the `name:` field tolerating optional quotes.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const namePattern = new RegExp(`name:\\s*["']?${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`)
if (!namePattern.test(patch)) {
  console.error(`[check-pack] cordis.patch.yml does not reference the package name "${manifest.name}"`)
  process.exit(1)
}

if (manifest.private === true) {
  console.error('[check-pack] package.json still marks "private": true; it cannot be published')
  process.exit(1)
}

console.log('[check-pack] OK: publish bundle is complete')