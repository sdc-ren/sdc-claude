#!/usr/bin/env node
// tf init — get a workspace ready for tf: what it is, what tf would write, and writing it after a yes.
//
//   tf init report <root>                     JSON: the workspace profile, its case (A–D), the gaps to close
//   tf init draft <root> [--from <file>]      JSON: the config tf would write (new or changed) and the diff
//   tf init apply <root> [--from <file>]      write the config, the local git excludes, the knowledge folder
//
// Cases:  A no config, no knowledge · B config + the workspace's own knowledge generator (only connect)
//         C config, no knowledge     · D knowledge, no config
// Nothing is installed or indexed here: the agent proposes those (codegraph init …) and runs them on a yes.
// `--from` reads another config on this machine for the wording of the sections every workspace shares; its path
// is never written anywhere.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { KNOWLEDGE_KEYS, knowledgeOf, readConfig, section } from '../../core/config.mjs'
import { PLUGIN_ROOT, isMain } from '../../core/main.mjs'
import { CONFIG_FILE, configPath } from '../../core/paths.mjs'
import { detect } from './detect.mjs'
import { CHECK_CMD, DEFAULT_ENTRY, DIFF_CMD, GEN_CMD, generate, ownable } from './gen.mjs'

const posix = (p) => p.split(sep).join('/')
const text = (p) => { try { return readFileSync(p, 'utf8').replace(/\r\n/g, '\n') } catch { return '' } }
const git = (cwd, args) => { try { return execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true }).toString().trim() } catch { return null } }

// ── Which case, which gaps ───────────────────────────────────────────────────
export function caseOf(p) {
  const k = p.knowledge
  if (!p.config.exists) return k.exists ? 'D' : 'A'
  if (k.exists && !k.ownedByTf && k.generator) return 'B'
  if (k.exists && k.ownedByTf) return 'C'
  return 'C'
}

export function gaps(p) {
  const out = []
  for (const t of p.tools) {
    if (!t.installed) out.push({ kind: 'tool', tool: t.name, say: `${t.name} is not installed — ${t.why}` })
    else if (t.missingIn.length) out.push({ kind: 'index', tool: t.name, repos: t.missingIn, say: `${t.name}: no index in ${t.missingIn.join(', ')}` })
  }
  if (p.agentFiles['CLAUDE.md'] && !p.agentFiles['AGENTS.md']) out.push({ kind: 'agents-md', say: 'CLAUDE.md but no AGENTS.md at the root: Codex reads AGENTS.md (a one-line AGENTS.md pointing to CLAUDE.md is enough)' })
  if (!p.gh) out.push({ kind: 'gh', say: '`gh` is not signed in — PRs and reviews need it (`gh auth login`)' })
  if (p.repos.length && !p.repos.some((r) => r.playwright)) out.push({ kind: 'playwright', say: 'no package depends on @playwright/test — e2e (/tf:e2e, the tester) needs one' })
  if (p.config.exists && !p.knowledge.configured) out.push({ kind: 'knowledge-config', say: 'the config has no Knowledge lines in tf\'s form — tf cannot check or use the maps' })
  return out
}

// ── The Knowledge lines ──────────────────────────────────────────────────────
function knowledgeLines(p, c) {
  const k = p.knowledge
  const lines = []
  const add = (key, value, note = '') => lines.push(`- ${KNOWLEDGE_KEYS[key]}: ${value}${note ? ` ${note}` : ''}`)
  const indexed = p.tools.some((t) => t.installed) || p.repos.some((r) => r.indexes.some((i) => i.indexed))
  if (c === 'B') {
    // The workspace's own generator: only commands its README lists, each to be confirmed.
    const cmds = k.readmeCommands
    const gen = cmds.find((x) => x.includes(k.generator) && !/--check\b/.test(x)) || `node ${k.generator}`
    const chk = cmds.find((x) => x.includes(k.generator) && /--check\b/.test(x))
    const diff = cmds.find((x) => /\bdiff\b/i.test(x) && /<SLUG>|--task/.test(x))
    add('entry', `\`${k.entryPath}\``)
    add('generate', `\`${gen}\``, '⚠ confirm')
    if (chk) add('check', `\`${chk}\``, '⚠ confirm')
    add('refresh', 'when needed')
    if (diff) add('diff', `\`${diff}\``, '⚠ confirm')
    if (existsSync(join(p.root, dirname(k.entryPath), 'pipeline'))) add('ledger', `\`${posix(join(dirname(k.entryPath), 'pipeline'))}/\``)
  } else {
    const entry = k.configured && k.entry ? k.entry : knowledgeEntry(p)
    add('entry', `\`${entry}\``)
    add('generate', `\`${GEN_CMD}\``)
    add('check', `\`${CHECK_CMD}\``)
    add('refresh', 'when needed')
    // The contract diff, when a repo serves routes tf can read.
    if (p.repos.some((r) => r.stack.some((s) => /^(Express|NestJS|Next\.js|Nuxt|Fastify)$/.test(s)))) add('diff', `\`${DIFF_CMD}\``)
    add('ledger', `\`${posix(join(dirname(entry), 'pipeline'))}/\``)
  }
  if (indexed) add('codeIndex', p.tools.filter((t) => t.installed).map((t) => t.name).join(', ') || 'codegraph')
  return lines
}

// knowledge/ unless that folder holds something that is not tf's — then .tf/knowledge/.
function knowledgeEntry(p) {
  return ownable(join(p.root, 'knowledge')) ? DEFAULT_ENTRY : '.tf/knowledge/README.md'
}

const KNOWLEDGE_HEADING = '## Knowledge (PM reads the entry first; jobs get their slices; the orchestrator writes only pipeline/)'

/** The config with tf's Knowledge lines at the top of its Knowledge section; every other line kept as it is. */
export function withKnowledge(cfg, lines) {
  const have = knowledgeOf(cfg)
  const missing = lines.filter((l) => {
    const key = Object.keys(KNOWLEDGE_KEYS).find((k) => l.startsWith(`- ${KNOWLEDGE_KEYS[k]}:`))
    return !key || !have[key]
  })
  if (!missing.length) return cfg
  const src = cfg.replace(/\r\n/g, '\n')
  const m = src.match(/^## Knowledge\b[^\n]*\n/m)
  if (m) {
    const at = m.index + m[0].length
    return `${src.slice(0, at)}${missing.join('\n')}\n${src.slice(at)}`
  }
  const block = `${KNOWLEDGE_HEADING}\n${missing.join('\n')}\n\n`
  const flows = src.search(/^## Flows\b/m)
  return flows >= 0 ? `${src.slice(0, flows)}${block}${src.slice(flows)}` : `${src.replace(/\n*$/, '\n\n')}${block}`
}

// ── A new config ─────────────────────────────────────────────────────────────
const SHARED = ['Language', 'Test policy', 'Escalation additions', 'Hard rules', 'Close-out', 'Doctor']

function replaceSection(doc, name, body, heading) {
  const re = new RegExp(`^## ${name}\\b[^\\n]*\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm')
  return doc.replace(re, (all) => `${heading || all.split('\n')[0]}\n${body.replace(/\n+$/, '')}\n\n`)
}

export function newConfig(p, { from = '' } = {}) {
  let doc = text(join(PLUGIN_ROOT, 'docs', 'config-template.md'))
  const notes = []
  doc = doc.replace(/^# task-flow config — <workspace name>/m, `# task-flow config — ${basename(p.root)}`)
  const pathOf = (r, f) => `${r.path === './' ? '' : r.path}${f}`
  // Repos.
  doc = replaceSection(doc, 'Repos', [
    '| key | path | base branch | package manager | lockfile → reusable dirs | conventions to read |',
    '|---|---|---|---|---|---|',
    ...p.repos.map((r) => `| ${r.key} | \`${r.path}\` | \`${r.base || 'main'}\` | ${r.packageManager || '—'} | ${r.lockfile ? `\`${r.lockfile}\`${r.reusable ? ` → \`${r.reusable}\`` : ''}` : '—'} | ${r.docs.filter((d) => /\.md$/.test(d)).map((d) => `\`${pathOf(r, d)}\``).join(', ') || '—'} |`),
  ].join('\n'))
  if (p.repos.some((r) => !r.base)) notes.push('base branch not found for some repos (no origin/HEAD): set it in the Repos table')
  // Checks: the test/lint/typecheck scripts the repos have.
  const checks = p.repos.flatMap((r) => ['test', 'typecheck', 'lint'].filter((s) => r.scripts[s]).map((s) => `| ${r.key} | \`${r.packageManager === 'npm' || !r.packageManager ? 'npm run' : r.packageManager} ${s}\` | from package.json ⚠ check the time it takes |`))
  if (checks.length) doc = replaceSection(doc, 'Checks', ['| repo | command (scoped to the touched modules when the runner can) | notes |', '|---|---|---|', ...checks, 'No row for a repo → its test script from the repo `CLAUDE.md` / package file when it runs in a few minutes; none → skipped, said so in the PR.'].join('\n'))
  // Knowledge.
  doc = replaceSection(doc, 'Knowledge', knowledgeLines(p, caseOf(p)).join('\n'), KNOWLEDGE_HEADING)
  // Flows: the Playwright package.
  const pw = p.repos.find((r) => r.playwright)
  if (pw) doc = doc.replace(/^- Playwright package: `<path>\/package.json`/m, `- Playwright package: \`${pathOf(pw, 'package.json')}\``)
  // Servers: one per repo that has a dev/start script.
  const servers = {}
  for (const r of p.repos) {
    const script = ['dev', 'start:dev', 'start', 'serve'].find((s) => r.scripts[s])
    if (!script) continue
    const run = r.packageManager === 'npm' || !r.packageManager ? `npm run ${script}` : `${r.packageManager} ${script}`
    servers[r.key] = { dir: r.path, port: true, cmd: run, timeout: 120, env: { PORT: '{port}' }, health: 'http://localhost:{port}/' }
  }
  if (Object.keys(servers).length) {
    const body = section(doc, 'Servers').replace(/```json[\s\S]*?```/, '```json\n' + JSON.stringify(servers, null, 2) + '\n```')
    doc = replaceSection(doc, 'Servers', `<!-- ⚠ detected from the repos' scripts: check each command, the port env and the health URL -->\n${body}`)
  }
  // The shared sections, in another config's wording.
  if (from) {
    const other = text(resolve(from))
    if (!other) throw new Error(`--from: cannot read ${from}`)
    for (const s of SHARED) {
      const body = section(other, s)
      if (body) { doc = replaceSection(doc, s, `<!-- ⚠ taken from another workspace's config: check it fits here -->\n${body}`); notes.push(`${s}: taken from the --from config`) }
    }
  }
  return { text: doc, notes }
}

// ── Draft and diff ───────────────────────────────────────────────────────────
// Lines added and removed, in order (a small LCS diff: configs are a few hundred lines).
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n')
  const n = x.length, m = y.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`- ${i + 1}: ${x[i++]}`)
    else out.push(`+ ${j + 1}: ${y[j++]}`)
  }
  while (i < n) out.push(`- ${i + 1}: ${x[i++]}`)
  while (j < m) out.push(`+ ${j + 1}: ${y[j++]}`)
  return out
}

export function draft(rootIn, { from = '' } = {}) {
  const p = detect(rootIn)
  const c = caseOf(p)
  const existing = p.config.exists ? readConfig(p.root) : ''
  let next, notes = []
  if (existing) next = withKnowledge(existing, knowledgeLines(p, c))
  else ({ text: next, notes } = newConfig(p, { from }))
  const path = existing ? posix(relative(p.root, configPath(p.root))) : posix(CONFIG_FILE)
  return { case: c, path, isNew: !existing, changed: next !== existing, text: next, diff: existing ? lineDiff(existing, next) : [], notes, confirm: (next.match(/⚠[^\n]*/g) || []).length }
}

// ── Apply ────────────────────────────────────────────────────────────────────
const STUBS = {
  'findings.md': '# Findings\n\nOne row per finding; change its status, never delete a row. Written by the orchestrator only.\n\n| ID | Date | Repo | Severity | Summary | Status | Source |\n|---|---|---|---|---|---|---|\n',
  'decisions.md': '# Decisions\n\nDecisions already taken, so nobody asks or decides them again. Written by the orchestrator only.\n\n| ID | Question | Answer | Date | Task |\n|---|---|---|---|---|\n',
  'env-recipes.md': '# Env recipes\n\nOne line per recipe verified on this machine: `- [repo] what — how (verified <date>, task <slug>)`.\n',
  'review-lessons.md': '# Review lessons\n\nOne line per rule learned from human PR reviews, led by its category tag (`[M1]`… guidelines/review-standard.md) and its source.\n',
}

// Lines for a repo's .git/info/exclude (this machine only; the project's .gitignore is not touched).
function exclude(repo, patterns) {
  const gitDir = git(repo, ['rev-parse', '--git-common-dir'])
  if (!gitDir) return []
  const file = resolve(repo, gitDir, 'info', 'exclude')
  const have = text(file).split('\n')
  const add = patterns.filter((x) => !have.includes(x))
  if (!add.length) return []
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${have.length && have.at(-1) !== '' ? '\n' : ''}# tf (task-flow) — local files of tf, never part of a change\n${add.join('\n')}\n`)
  return add.map((x) => `${posix(relative(process.cwd(), repo)) || '.'}: ${x}`)
}

export function apply(rootIn, { from = '' } = {}) {
  const d = draft(rootIn, { from })
  const p = detect(rootIn)
  const done = []
  if (d.changed) {
    const f = join(p.root, d.path)
    mkdirSync(dirname(f), { recursive: true })
    // Applying is the user's yes to the commands marked for confirmation.
    writeFileSync(f, d.text.replace(/ ⚠ confirm$/gm, ''))
    done.push(`${d.isNew ? 'wrote' : 'updated'} ${d.path}`)
  }
  const k = knowledgeOf(d.text)
  const entry = k.entry || DEFAULT_ENTRY
  const kdir = posix(dirname(entry))
  // One repo at the workspace root: tf's folders live inside it.
  const rootRepo = p.repos.find((r) => r.path === './')
  if (rootRepo) done.push(...exclude(p.root, ['/.worktrees/', '/.pipeline/', `/${kdir}/*`, `!/${kdir}/pipeline/`, '/.tf/config.md'].filter((x, i) => i < 4 || d.isNew)))
  // Index folders git would show.
  for (const r of p.repos) for (const i of r.indexes) if (i.indexed && git(r.abs, ['check-ignore', '-q', `.${i.tool}`]) === null) done.push(...exclude(r.abs, [`/.${i.tool}/`]))
  // tf's own knowledge: hand-kept note stubs, then the maps.
  if (d.case !== 'B') {
    const pdir = join(p.root, kdir, 'pipeline')
    mkdirSync(pdir, { recursive: true })
    for (const [f, body] of Object.entries(STUBS)) if (!existsSync(join(pdir, f))) { writeFileSync(join(pdir, f), body); done.push(`created ${kdir}/pipeline/${f}`) }
    const g = generate(p.root)
    done.push(`knowledge: ${g.written.length} generated files in ${kdir}/`)
  }
  return { case: d.case, path: d.path, done, notes: d.notes, gaps: gaps(p) }
}

if (isMain(import.meta.url, 'scripts/init.mjs')) {
  const [cmd, root = '.', ...rest] = process.argv.slice(2)
  const i = rest.indexOf('--from')
  const from = i >= 0 ? rest[i + 1] || '' : ''
  try {
    if (cmd === 'report' || cmd === 'detect') { const p = detect(root); console.log(JSON.stringify({ case: caseOf(p), gaps: gaps(p), profile: p }, null, 2)) }
    else if (cmd === 'draft') console.log(JSON.stringify(draft(root, { from }), null, 2))
    else if (cmd === 'apply') console.log(JSON.stringify(apply(root, { from }), null, 2))
    else { console.error('usage: init.mjs report|draft|apply <root> [--from <config file>]'); process.exit(2) }
  } catch (e) {
    console.error(`init: ${e.message}`)
    process.exit(2)
  }
}
