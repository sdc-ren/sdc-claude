#!/usr/bin/env node
// tf: is this commit message / PR title written per guidelines/git.md? The same rules the tool guard applies
// to `git commit -m` and `gh pr create|edit --title` (hooks/guard.ts keeps a copy: a hook loads no script).
//
//   node naming.mjs check --kind commit|pr [--key <KEY>] (--file <message file> | "<first line>")
//     exit 0 and nothing printed when it is right; exit 1 and one line per problem when not.
//   import { checkTitle, issueKey } from './naming.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'style', 'chore']
// An issue key as trackers write it (PROJ-12, GH-WEB-9); a task slug that is one is the task's key.
export const KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/
export const issueKey = (slug) => (KEY.test(String(slug || '')) ? String(slug) : '')
// Vietnamese and other accented Latin letters: a PR title is English.
const ACCENTED = /[À-ɏḀ-ỿ]/
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Problems with the first line of a commit message or a PR title ([] = fine).
export function checkTitle(text, { kind = 'commit', key = '' } = {}) {
  const line = String(text || '').split(/\r?\n/)[0].trim()
  const out = []
  const m = line.match(new RegExp(`^(${TYPES.join('|')})(?:\\(([^)]*)\\))?(!)?: (\\S.*)$`))
  if (!m) {
    out.push(`not "<type>(${key || '<scope>'}): <summary>" — type one of ${TYPES.join(', ')}`)
  } else {
    const [, , scope = '', , summary] = m
    if (key) {
      if (scope !== key) out.push(`the issue key is the scope: "${m[1]}(${key}): …"${scope ? `, not "(${scope})"` : ''}`)
      if (new RegExp(esc(key), 'i').test(summary)) out.push(`the key appears in the summary too — it belongs in the parentheses only`)
    } else if (scope && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope)) out.push(`scope "${scope}" is not lowercase kebab-case`)
    if (/\.$/.test(summary)) out.push('no trailing period')
  }
  if (/\[[A-Z][A-Z0-9]*-\d+\]/.test(line)) out.push('no [KEY] in brackets')
  if (kind === 'pr' && ACCENTED.test(line)) out.push('a PR title is English: no accented letters (write it for the PR, do not copy a commit in another language)')
  if (line.length > 100) out.push(`${line.length} characters — keep it to about 72`)
  return out
}

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
