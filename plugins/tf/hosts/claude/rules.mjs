#!/usr/bin/env node
// SDC tf rules: the instruction files Claude Code loads for a workspace, and the mechanical checks on them —
// size against a budget, references to tf scripts and flags that do not exist, a memory index out of step with
// its files. What the files SAY (contradictions, duplicates, wrong scope) is /tf:rules-audit's job, not this one.
//
//   node rules.mjs check <root> [--json]       one line per finding (warnings only, exit 0)
//   node rules.mjs inventory <root> [--json]   every file: scope, words, lines, when it is loaded
//
//   import { ruleFiles, checkRules } from './rules.mjs'
import { isMain } from '../../core/main.mjs'
import { configPath } from '../../core/paths.mjs'
import { repoRows } from '../../core/config.mjs'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Words per file (or per scope where noted). Past a budget the file is worth a /tf:rules-audit, not an error.
export const BUDGET = {
  global: 1500, // ~/.claude/CLAUDE.md with its @imports, every session on this machine
  ancestor: 1000, // CLAUDE.md / AGENTS.md in a folder above the workspace
  project: 2000, // the workspace's own CLAUDE.md, AGENTS.md, .claude/rules/
  repo: 3000, // a repo's CLAUDE.md, loaded when work happens in that repo
  'tf-config': 4000, // .claude/task-flow.md, printed to roles section by section
  'memory-index': 2000, // MEMORY.md, every session in the workspace
  memory: 500, // one memory file, loaded when recalled
  always: 4000, // global + ancestors + project + memory index together
}
// Claude Code reads only the first 200 lines of MEMORY.md; leave room before entries silently drop off.
export const MEMORY_INDEX_LINES = 150
const LOADED = { global: 'every session', ancestor: 'every session under it', project: 'every session here', repo: 'work in that repo', 'tf-config': 'tf runs', 'memory-index': 'every session here', memory: 'when recalled' }

const words = (s) => (s.match(/\S+/g) || []).length
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const mdIn = (dir) => { try { return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.md')).map((f) => join(dir, String(f))) } catch { return [] } }
// Claude Code's folder name for a project: every character that is not a letter or digit becomes '-'.
export const projectSlug = (root) => resolve(root).replace(/[^a-zA-Z0-9]/g, '-')

/**
 * The instruction files for a workspace, in load order, each read once.
 * @param {string} root workspace root
 * @param {{ home?: string }} [o]
 * @returns {{ path: string, scope: string, loaded: string, words: number, lines: number, text: string, via?: string }[]}
 */
export function ruleFiles(root, { home = homedir() } = {}) {
  root = resolve(root)
  const out = []
  const seen = new Set()
  const add = (path, scope, via) => {
    path = resolve(path)
    if (!isFile(path)) return
    const real = realpathSync(path) // AGENTS.md is often a link to CLAUDE.md: one file, read once
    if (seen.has(real)) return
    const text = read(path)
    if (text == null) return
    seen.add(real)
    out.push({ path, scope, loaded: LOADED[scope], words: words(text), lines: text.split('\n').length, text, ...(via && { via }) })
    // @path imports (a line that is only "@file"), relative to the importing file; one level is what we follow.
    if (!via) for (const m of text.matchAll(/^@(\S+)\s*$/gm)) add(m[1].startsWith('~/') ? join(home, m[1].slice(2)) : resolve(dirname(path), m[1]), scope, path)
  }
  const claudeDir = join(home, '.claude')
  add(join(claudeDir, 'CLAUDE.md'), 'global')
  for (const f of mdIn(join(claudeDir, 'rules'))) add(f, 'global')
  // Folders above the workspace, home first (outside home: only up to the filesystem root's child).
  const above = []
  for (let d = dirname(root); d !== dirname(d); d = dirname(d)) { above.unshift(d); if (d === resolve(home)) break }
  for (const d of above) for (const n of ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md']) add(join(d, n), 'ancestor')
  for (const n of ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) add(join(root, n), 'project')
  for (const f of mdIn(join(root, '.claude', 'rules'))) add(f, 'project')
  // Repos: the config's repo table, else every direct child folder with its own CLAUDE.md.
  const cfgPath = configPath(root)
  const cfg = read(cfgPath) || ''
  const repos = new Set(repoRows(cfg).map((r) => join(root, r.path)))
  try { for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) repos.add(join(root, e.name)) } catch {}
  for (const r of repos) for (const n of ['CLAUDE.md', 'AGENTS.md']) add(join(r, n), 'repo')
  add(cfgPath, 'tf-config')
  const mem = join(claudeDir, 'projects', projectSlug(root), 'memory')
  add(join(mem, 'MEMORY.md'), 'memory-index')
  for (const f of mdIn(mem).sort()) add(f, 'memory')
  return out
}

// A tf script a rule names: `scripts/<name>.mjs`, `$S/<name>.mjs`, `<scripts>/<name>.mjs` … and the --flags
// written after it in the same code span.
const SCRIPT_REF = /(?:scripts\/|\$S\/|<scripts>\/)([\w-]+)\.mjs([^`\n]*)/g
function moduleSource(name) {
  const entry = join(PLUGIN, 'scripts', `${name}.mjs`)
  const src = read(entry)
  if (src == null) return null
  // An old entry point re-exports the module that holds the code (and the CLI).
  const m = src.match(/export \* from '([^']+)'/)
  return m ? (read(resolve(dirname(entry), m[1])) ?? src) : src
}
export function deadRefs(text) {
  const out = []
  const cache = {}
  for (const m of text.matchAll(SCRIPT_REF)) {
    const [, name, tail] = m
    if (!(name in cache)) cache[name] = moduleSource(name)
    const src = cache[name]
    if (src == null) { out.push(`${name}.mjs — no such tf script`); continue }
    for (const f of tail.matchAll(/(?:^|\s)(--[a-z][\w-]*)/g)) {
      if (!src.includes(f[1].slice(2))) out.push(`${name}.mjs ${f[1]} — the script has no such option`)
    }
  }
  return [...new Set(out)]
}

/**
 * @param {string} root
 * @param {{ home?: string, files?: ReturnType<typeof ruleFiles> }} [o]
 * @returns {{ label: string, detail: string }[]} warnings
 */
export function checkRules(root, { home = homedir(), files } = {}) {
  files = files || ruleFiles(root, { home })
  const warn = []
  const show = (p) => (p.startsWith(resolve(home) + sep) ? `~/${relative(home, p).split(sep).join('/')}` : p)
  // Size: a global file is judged with its imports, as it is loaded.
  const global = files.filter((f) => f.scope === 'global').reduce((n, f) => n + f.words, 0)
  if (global > BUDGET.global) warn.push({ label: 'rules: global instructions too long', detail: `${global} words (budget ${BUDGET.global}) — ~/.claude/CLAUDE.md and its imports load in every session` })
  for (const f of files) {
    if (f.scope === 'global') continue
    if (f.words > BUDGET[f.scope]) warn.push({ label: `rules: ${show(f.path)} too long`, detail: `${f.words} words (budget ${BUDGET[f.scope]}, loaded ${f.loaded})` })
  }
  const always = files.filter((f) => ['global', 'ancestor', 'project', 'memory-index'].includes(f.scope)).reduce((n, f) => n + f.words, 0)
  if (always > BUDGET.always) warn.push({ label: 'rules: always-loaded total too long', detail: `${always} words (budget ${BUDGET.always}) in every session of this workspace` })
  // Memory index: line cap, links to missing files, files the index does not list.
  const index = files.find((f) => f.scope === 'memory-index')
  if (index) {
    if (index.lines > MEMORY_INDEX_LINES) warn.push({ label: 'rules: MEMORY.md near the 200-line cut', detail: `${index.lines} lines — entries past line 200 are never loaded` })
    const dir = dirname(index.path)
    const linked = new Set([...index.text.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => resolve(dir, m[1])))
    for (const l of linked) if (!isFile(l)) warn.push({ label: 'rules: MEMORY.md links a missing file', detail: relative(dir, l) })
    for (const f of files) if (f.scope === 'memory' && !linked.has(f.path)) warn.push({ label: 'rules: memory not in MEMORY.md', detail: `${relative(dir, f.path)} — never recalled from the index` })
  }
  for (const f of files) for (const d of deadRefs(f.text)) warn.push({ label: `rules: ${show(f.path)} names a missing script or option`, detail: d })
  return warn
}

if (isMain(import.meta.url, 'scripts/rules.mjs')) {
  const [cmd, root = '.', ...rest] = process.argv.slice(2)
  const json = rest.includes('--json')
  if (cmd === 'inventory') {
    const files = ruleFiles(root).map(({ text, ...f }) => f)
    if (json) console.log(JSON.stringify(files, null, 2))
    else for (const f of files) console.log(`${String(f.words).padStart(6)} words ${String(f.lines).padStart(5)} lines  ${f.scope.padEnd(12)} ${f.path}`)
  } else if (cmd === 'check') {
    const w = checkRules(root)
    if (json) console.log(JSON.stringify(w, null, 2))
    else { for (const r of w) console.log(`! ${r.label}  ${r.detail}`); console.log(w.length ? `${w.length} warning(s) — /tf:rules-audit reads them and proposes fixes` : 'rules: within budget, no dead references') }
  } else {
    console.error('usage: rules.mjs check|inventory <root> [--json]')
    process.exit(2)
  }
}
