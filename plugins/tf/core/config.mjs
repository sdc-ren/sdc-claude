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
  tester: ['Flows', 'Servers', 'Test policy'],
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
