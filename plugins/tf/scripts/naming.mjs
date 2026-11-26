#!/usr/bin/env node
// tf: is this commit message / PR title written per guidelines/git.md? The rules live in core/naming.mjs,
// the same ones the tool guard applies to `git commit -m` and `gh pr create|edit --title`.
//
//   node naming.mjs check --kind commit|pr [--key <KEY>] (--file <message file> | "<first line>")
//     exit 0 and nothing printed when it is right; exit 1 and one line per problem when not.
//   import { checkTitle, issueKey } from './naming.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KEY, checkTitle } from '../core/naming.mjs'

export { KEY, TYPES, checkTitle, issueKey } from '../core/naming.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2)
  const flag = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a.splice(i, 2)[1] : '' }
  if (a.shift() !== 'check') { console.error('usage: naming.mjs check --kind commit|pr [--key KEY] (--file F | "<line>")'); process.exit(2) }
  const kind = flag('kind') || 'commit'
  const key = flag('key')
  const file = flag('file')
  if (key && !KEY.test(key)) { console.error(`not an issue key: ${key}`); process.exit(2) }
  const text = file ? readFileSync(resolve(file), 'utf8') : a.join(' ')
  const bad = checkTitle(text, { kind, key })
  for (const b of bad) console.log(`✗ ${b}`)
  process.exit(bad.length ? 1 : 0)
}
