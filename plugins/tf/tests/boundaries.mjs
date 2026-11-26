// tf — layer boundaries (plans/tf-architecture.md §3). Imports only point inward, and the shared code never
// names a coding agent.
//
//   enforced now : core/ imports only node:* and core/; the hook-safe core files import no node:* at all;
//                  core/ names no agent (outside the allow list below); no host imports another host.
//   reported     : shared code that imports hosts/, and how often each shared file names an agent. These
//                  become enforced as the migration reaches them. TF_BOUNDARIES=strict enforces them today.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.env.TF_BOUNDARIES === 'strict'
const CODE = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/
const SKIP_DIRS = new Set(['node_modules', 'types', '.git'])

// Core files a host's hook module imports. A hook module may run with no Node, so these import nothing but
// each other.
const HOOK_SAFE = new Set(['core/naming.mjs', 'core/guard-rules.mjs'])

// Agent names in shared code. Cursor and Kiro only capitalised: `cursor` is also an ordinary word in code.
const AGENT_WORDS = /\b(?:claude|codex|copilot)\b|\b(?:Cursor|Kiro)\b|AskUserQuestion|\bmcp__\w+|\bCLAUDE_[A-Z_]+/gi
const word = (m) => (/^mcp__/i.test(m) ? 'mcp__' : /^AskUserQuestion$/i.test(m) ? 'AskUserQuestion' : /^CLAUDE_/.test(m) ? m : m.toLowerCase())
// Where core/ may still name an agent, and why. Each entry is removed when its reason goes away.
const CORE_ALLOW = {
  'core/paths.mjs': { claude: 'the legacy folders ~/.claude/task-flow and <root>/.claude/task-flow.md are still read' },
  'core/platform.mjs': { CLAUDE_CODE_GIT_BASH_PATH: 'the Git Bash a coding agent names for itself is one of the candidates' },
  'core/guard-rules.mjs': { claude: 'the deny message names the legacy state folder until the state migration' },
}

const rel = (p) => relative(ROOT, p).split(sep).join('/')
function walk(dir, keep) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, keep))
    else if (keep(e.name)) out.push(p)
  }
  return out
}
const filesIn = (top, keep = (n) => CODE.test(n)) => { try { return walk(join(ROOT, top), keep) } catch { return [] } }

// Static and dynamic import specifiers of a file.
function specifiers(file) {
  // Comment lines are not imports, even when they show one.
  const src = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n')
  const out = []
  for (const m of src.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return [...new Set(out)]
}
// A relative specifier as a path from the plugin root ('' for a package or node:*).
const target = (file, spec) => (spec.startsWith('.') ? rel(resolve(dirname(file), spec)) : '')
const hostOf = (r) => (r.startsWith('hosts/') ? r.split('/')[1] : '')
function agentWords(file) {
  const counts = {}
  for (const m of readFileSync(file, 'utf8').matchAll(AGENT_WORDS)) counts[word(m[0])] = (counts[word(m[0])] || 0) + 1
  return counts
}

test('core imports only node:* and core/', () => {
  const bad = []
  for (const f of filesIn('core')) for (const s of specifiers(f)) {
    if (s.startsWith('node:')) continue
    const t = target(f, s)
    if (!t.startsWith('core/')) bad.push(`${rel(f)} → ${s}`)
  }
  assert.deepEqual(bad, [], 'core/ must not depend on scripts/, engine/, hosts/ or a package')
})

test('the hook-safe core files import nothing but each other', () => {
  const bad = []
  for (const r of HOOK_SAFE) {
    const f = join(ROOT, r)
    for (const s of specifiers(f)) if (!HOOK_SAFE.has(target(f, s))) bad.push(`${r} → ${s}`)
  }
  assert.deepEqual(bad, [], 'a host hook module may have no Node: these files stay free of node:* imports')
})

test('core names no coding agent, outside the allow list', () => {
  const bad = []
  for (const f of filesIn('core')) {
    const r = rel(f)
    const allow = CORE_ALLOW[r] || {}
    for (const [w, n] of Object.entries(agentWords(f))) if (!allow[w]) bad.push(`${r}: "${w}" ×${n}`)
  }
  assert.deepEqual(bad, [], 'core/ is host-neutral: move agent-specific code to hosts/<agent>/, or add a reason to CORE_ALLOW')
})

test('the allow list has no stale entries', () => {
  const stale = []
  for (const [r, words] of Object.entries(CORE_ALLOW)) {
    let found = {}
    try { found = agentWords(join(ROOT, r)) } catch { stale.push(`${r} (no such file)`); continue }
    for (const w of Object.keys(words)) if (!found[w]) stale.push(`${r}: ${w}`)
  }
  assert.deepEqual(stale, [], 'remove allow-list entries whose word no longer appears')
})

// The shared layers above core: what each may import (besides node:* and itself).
const MAY_IMPORT = {
  modules: ['core/', 'modules/'],
  cli: ['core/', 'modules/', 'cli/'],
  'engine/src': ['engine/src/'],
  build: ['core/', 'build/'],
}
for (const [top, allowed] of Object.entries(MAY_IMPORT)) {
  test(`${top}/ imports only ${allowed.join(', ')}`, () => {
    const bad = []
    for (const f of filesIn(top)) for (const s of specifiers(f)) {
      if (s.startsWith('node:')) continue
      const t = target(f, s)
      if (!allowed.some((a) => t.startsWith(a))) bad.push(`${rel(f)} → ${s}`)
    }
    assert.deepEqual(bad, [], `${top}/ is shared: it never reaches into hosts/, scripts/ or engine/`)
  })
}

test('the old scripts/ entry points are only re-exports', () => {
  const bad = []
  for (const f of filesIn('scripts')) {
    const code = readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('//') && !l.startsWith('#!'))
    if (rel(f) === 'scripts/platform.mjs') continue // also adds the Claude Code data folder to `info`
    if (!code.every((l) => /^export \* from '\.\.\/[\w/.-]+'$/.test(l))) bad.push(rel(f))
  }
  assert.deepEqual(bad, [], 'scripts/ holds no code of its own any more: put it in core/, modules/ or hosts/')
})

// Shared text names what to do, never how one agent does it: those steps are marked *(host: …)* and each host's
// notes say how (hosts/<agent>/notes.md). Product names in data (a claude.ai link as a source, a repo's
// CLAUDE.md) are fine; an agent's tools, variables and commands are not.
const HOST_OPERATIONS = /AskUserQuestion|\bmcp__\w+|CLAUDE_PLUGIN_ROOT|\$ARGUMENTS|run_in_background|`Workflow`/g
test('docs, guidelines and content name no agent\'s tools or variables', () => {
  const bad = []
  for (const top of ['docs', 'guidelines', 'content']) for (const f of filesIn(top, (n) => n.endsWith('.md'))) {
    const hits = [...new Set([...readFileSync(f, 'utf8').matchAll(HOST_OPERATIONS)].map((m) => m[0]))]
    if (hits.length) bad.push(`${rel(f)}: ${hits.join(', ')}`)
  }
  assert.deepEqual(bad, [], 'say it as a *(host: …)* step and put the agent\'s way in hosts/<agent>/notes.md')
})

test('no host imports another host', () => {
  const bad = []
  for (const f of filesIn('hosts')) for (const s of specifiers(f)) {
    const from = hostOf(rel(f)), to = hostOf(target(f, s))
    if (to && to !== from) bad.push(`${rel(f)} → ${s}`)
  }
  assert.deepEqual(bad, [])
})

// ── Reported (enforced with TF_BOUNDARIES=strict) ────────────────────────────
const SHARED_CODE = ['modules', 'cli', 'engine', 'hooks']
const SHARED_TEXT = ['agents', 'skills', 'docs', 'guidelines']

test('report: shared code that imports a host', (t) => {
  const hits = []
  for (const top of SHARED_CODE) for (const f of filesIn(top)) for (const s of specifiers(f)) if (hostOf(target(f, s))) hits.push(`${rel(f)} → ${s}`)
  for (const h of hits) t.diagnostic(`imports a host: ${h}`)
  t.diagnostic(`${hits.length} import(s) from shared code into hosts/`)
  if (STRICT) assert.deepEqual(hits, [])
})

test('report: shared files that name a coding agent', (t) => {
  const rows = []
  for (const top of SHARED_CODE) for (const f of filesIn(top)) rows.push([rel(f), agentWords(f)])
  for (const top of SHARED_TEXT) for (const f of filesIn(top, (n) => n.endsWith('.md'))) rows.push([rel(f), agentWords(f)])
  const named = rows.filter(([, c]) => Object.keys(c).length)
  let total = 0
  for (const [r, c] of named.sort((a, b) => a[0].localeCompare(b[0]))) {
    const n = Object.values(c).reduce((a, b) => a + b, 0)
    total += n
    t.diagnostic(`${r}: ${Object.entries(c).map(([w, k]) => `${w}×${k}`).join(' ')}`)
  }
  t.diagnostic(`${named.length} of ${rows.length} shared files name an agent (${total} mentions)`)
  if (STRICT) assert.deepEqual(named.map(([r]) => r), [])
})
