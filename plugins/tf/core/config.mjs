// tf core — the workspace config (core/paths.mjs says which file): reading it, and the sections one role needs.
import { existsSync, readFileSync } from 'node:fs'

import { configPath } from './paths.mjs'

// The config's text, '' when there is none.
export function readConfig(root) {
  const file = configPath(root)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

// The sections of the workspace config one role needs, instead of the whole file in every agent's context.
// A section is a `## ` heading and everything to the next one; a name matches the start of a heading, any case
// ("servers" → "## Servers (`serve.mjs` …)"). `--role <r>` takes that role's list (ROLE_SECTIONS). Hard rules come
// with every role. A name with no section is listed at the end, so nothing is silently missing.
export const ROLE_SECTIONS = {
  setup: ['Provisioning', 'Servers', 'Tool-touched files'],
  dev: ['Repos', 'Excluded', 'Read-only zones', 'Test policy', 'Team agreements', 'Checks', 'Tool-touched files', 'Knowledge'],
  tester: ['Flows', 'Servers', 'Test policy', 'Knowledge'],
  reviewer: ['Repos', 'Excluded', 'Read-only zones', 'Test policy', 'Team agreements', 'Checks', 'Tool-touched files', 'Knowledge'],
}
export function configSections(root, names) {
  const file = configPath(root)
  const text = readConfig(root)
  const parts = text.split(/\n(?=## )/)
  const want = [...new Set([...names, 'Hard rules'])]
  const got = [], missing = []
  for (const n of want) {
    const hit = parts.filter((p) => p.startsWith('## ') && p.slice(3).toLowerCase().startsWith(n.toLowerCase()))
    if (hit.length) for (const h of hit) { if (!got.includes(h)) got.push(h) } else missing.push(n)
  }
  return got.map((p) => p.trimEnd()).join('\n\n') + (missing.length ? `\n\n(no section in ${file}: ${missing.join(', ')})` : '') + '\n'
}

// One `## <name>` section of the config (heading matched by its start, any case), without the heading. '' if none.
export function section(text, name) {
  const parts = String(text || '').replace(/\r\n/g, '\n').split(/\n(?=## )/)
  const hit = parts.find((p) => p.startsWith('## ') && p.slice(3).toLowerCase().startsWith(name.toLowerCase()))
  return hit ? hit.slice(hit.indexOf('\n') + 1).replace(/\n+$/, '') : ''
}

// The repos table: | key | `path` | `base` | … → [{ key, path, base }] (base '' when the cell has none).
export function repoRows(text) {
  const out = []
  for (const m of String(text || '').matchAll(/^\|\s*([\w-]+)\s*\|\s*`([^`]+)`\s*\|\s*([^|\n]*)\|/gm)) {
    if (m[1] === 'key' || m[1] === 'kind') continue
    out.push({ key: m[1], path: m[2], base: ((m[3].match(/`([^`]+)`/) || [])[1] || '').trim() })
  }
  return out
}

// The lines of the `## Knowledge` section in tf's form (`- Entry: …`, `- Generate: …` …). A value in backticks is
// taken from them; otherwise the text before a trailing "(…)" note. Lines a person wrote in any other form are
// kept by `init` and ignored here.
export const KNOWLEDGE_KEYS = { entry: 'Entry', generate: 'Generate', check: 'Check', refresh: 'Refresh', diff: 'Diff', topics: 'Topics', ledger: 'Ledger', codeIndex: 'Code index', apiPrefix: 'API prefix', apiClients: 'API clients', stateEnums: 'State enums', featureTags: 'Feature tags' }
export function knowledgeOf(text) {
  const body = section(text, 'Knowledge')
  const out = {}
  for (const [k, label] of Object.entries(KNOWLEDGE_KEYS)) {
    const m = body.match(new RegExp(`^-\\s*${label}:\\s*(.+)$`, 'mi'))
    if (!m) continue
    const tick = m[1].match(/`([^`]+)`/)
    out[k] = (tick ? tick[1] : m[1].replace(/\s+\(.*\)\s*$/, '')).trim()
  }
  return out
}
