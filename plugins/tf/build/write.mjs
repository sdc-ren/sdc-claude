// tf build — write generated files, or check that the ones in the repository match what the build gives.
//   writeAll(files)  files: { 'plugin-relative path': text } → writes the changed ones, returns their paths
//   stale(files)     → the paths whose file on disk differs from the build (missing counts)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PLUGIN_ROOT } from '../core/main.mjs'

const onDisk = (rel) => { const f = join(PLUGIN_ROOT, rel); return existsSync(f) ? readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null }

export const stale = (files) => Object.entries(files).filter(([rel, text]) => onDisk(rel) !== text).map(([rel]) => rel)

export function writeAll(files) {
  const changed = stale(files)
  for (const rel of changed) {
    const f = join(PLUGIN_ROOT, rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, files[rel])
  }
  return changed
}

// The command line every host build shares: `node hosts/<agent>/build.mjs [--check]`.
export function cli(name, files) {
  const check = process.argv.includes('--check')
  const out = check ? stale(files) : writeAll(files)
  if (check && out.length) {
    console.error(`${name}: generated files out of date — run node <plugin>/hosts/${name}/build.mjs:\n${out.map((f) => `  ${f}`).join('\n')}`)
    process.exit(1)
  }
  console.log(check ? `${name}: ${Object.keys(files).length} generated files up to date` : out.length ? `${name}: wrote ${out.join(', ')}` : `${name}: nothing to write`)
}
