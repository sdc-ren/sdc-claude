#!/usr/bin/env node
// tf: what a run really cost — measured from the transcripts Claude Code keeps for every workflow agent
// (~/.claude/projects/<workspace>/<session>/subagents/workflows/wf_*/agent-*.jsonl), not estimated by the
// engine. Per job: wall time, time waiting on tools vs. model time, turns, tool calls, tokens, slowest
// commands. Per run: wall time, minutes per role, PM turns, dev/tester job counts, re-tests.
//
//   node metrics.mjs <root> <slug> [--last | --run wf_<id>] [--json]   runs of one task (all rounds); writes
//                                                                    <task>/metrics.json unless --json
//   node metrics.mjs <root> --all [--days 30] [--json]                one line per run, every task, with the
//                                                                    plugin version — compare versions
//   import { runsOf } from './metrics.mjs'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROLES = ['pm', 'setup', 'lead', 'dev', 'flows', 'tester', 'reviewer']
// Servers started or killed by hand instead of through serve.mjs (dev/tester rule) — counted, not judged.
const BY_HAND = /\bnohup\b|\b(npm|pnpm|yarn) (run )?(dev|start)\b|\bp?kill\b/
const min = (ms) => Math.round(ms / 6000) / 10
const k = (n) => Math.round(n / 1000)
const ls = (d) => { try { return readdirSync(d) } catch { return [] } }
const json = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }

function label(desc) {
  const pm = desc.match(/^PM t(\d+)/)
  if (pm) return { role: 'pm', repo: '', id: `PM${pm[1]}` }
  // "J2 lead:be" (plan or solo work), "J2 lead:be merge", members "J2a dev:be".
  const j = desc.match(/^(J\d+[a-c]?)\s+(\w+):(\S+)( merge)?/)
  return j ? { id: j[4] ? `${j[1]}m` : j[1], role: j[2], repo: j[3] } : { id: desc, role: 'other', repo: '' }
}

// One agent transcript → its numbers. Assistant messages are stored once per content block, so usage is
// counted once per message id.
function agent(file, meta) {
  const a = { ...label(meta.description || ''), label: meta.description || '', turns: 0, tools: 0, byHand: 0, out: 0, fresh: 0, cacheRead: 0, peak: 0, model: '' }
  const pending = new Map()
  const seen = new Set()
  const calls = []
  let t0 = 0, t1 = 0, head = ''
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const t = e.timestamp ? Date.parse(e.timestamp) : 0
    if (t) { t0 ||= t; t1 = t }
    const m = e.message || {}
    if (e.type === 'user' && typeof m.content === 'string' && head.length < 20_000) head += m.content
    const content = Array.isArray(m.content) ? m.content : []
    for (const c of content) {
      if (c.type === 'tool_use') {
        a.tools++
        const i = c.input || {}
        if (c.name === 'Bash' && BY_HAND.test(String(i.command || '')) && !/serve\.mjs/.test(i.command)) a.byHand++
        pending.set(c.id, { t, name: c.name, what: String(i.command || i.file_path || i.query || '').replace(/\s+/g, ' ').slice(0, 160) })
      } else if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const p = pending.get(c.tool_use_id)
        pending.delete(c.tool_use_id)
        calls.push({ sec: Math.round((t - p.t) / 1000), tool: p.name, what: p.what })
      }
    }
    if (e.type === 'assistant' && m.id && !seen.has(m.id)) {
      seen.add(m.id)
      a.turns++
      const u = m.usage || {}
      const fresh = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      a.out += u.output_tokens || 0
      a.fresh += fresh
      a.cacheRead += u.cache_read_input_tokens || 0
      a.peak = Math.max(a.peak, fresh + (u.cache_read_input_tokens || 0))
      if (m.model) a.model = m.model.replace(/^claude-/, '')
    }
  }
  if (!t0) return null
  const ctx = head.match(/Task (\S+) · mode (\w+) · round (\d+)/)
  const scripts = (head.match(/Scripts: (\S+)/) || [])[1] || ''
  if (a.role === 'tester' && /Brief:\s*FLOWS\b/.test(head)) a.role = 'flows' // writes flows next to the dev; not a test
  if (!['lead', 'dev', 'tester', 'flows'].includes(a.role)) a.byHand = 0
  const toolMs = Math.min(t1 - t0, calls.reduce((s, c) => s + c.sec * 1000, 0))
  return {
    ...a, start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), _t0: t0, _t1: t1,
    min: min(t1 - t0), toolMin: min(toolMs), modelMin: min(t1 - t0 - toolMs),
    slowest: calls.sort((x, y) => y.sec - x.sec).slice(0, 3).filter((c) => c.sec >= 20),
    _slug: ctx ? ctx[1] : '', _mode: ctx ? ctx[2] : '', _round: ctx ? Number(ctx[3]) : 0, _scripts: scripts,
  }
}

// Version that ran: the plugin cache path carries it. Installed from a folder, the path has none — then it
// is that folder's version only when its manifest has not changed since the run ended, else just "dev".
function versionOf(scripts, endMs) {
  const m = scripts.match(/\/tf\/(\d+\.\d+\.\d+)\//)
  if (m) return m[1]
  const manifest = join(scripts, '..', '.claude-plugin', 'plugin.json')
  let fresh = false
  try { fresh = statSync(manifest).mtimeMs <= endMs } catch {}
  const v = fresh && json(manifest, {}).version
  return v ? `${v}-dev` : 'dev'
}

function run(wfDir) {
  const agents = []
  for (const f of ls(wfDir)) {
    if (!f.endsWith('.meta.json')) continue
    const meta = json(join(wfDir, f), {})
    if (!/^tf[:-]/.test(meta.agentType || '') && !/^(PM t\d+|J\d+ )/.test(meta.description || '')) continue
    const t = join(wfDir, f.replace('.meta.json', '.jsonl'))
    const a = existsSync(t) && agent(t, meta)
    if (a) agents.push(a)
  }
  const first = agents.find((a) => a._slug)
  if (!first) return null
  agents.sort((x, y) => x._t0 - y._t0)
  const start = agents[0]._t0
  const end = Math.max(...agents.map((a) => a._t1))
  // The PM's size, from the workflow journal (the last PM result that names one).
  let size = ''
  for (const line of (existsSync(join(wfDir, 'journal.jsonl')) ? readFileSync(join(wfDir, 'journal.jsonl'), 'utf8') : '').split('\n')) {
    const s = line.includes('"size"') && json2(line)
    if (s && s.result && s.result.size) size = s.result.size
  }
  const byRole = {}
  for (const r of ROLES) {
    const of = agents.filter((a) => a.role === r)
    if (of.length) byRole[r] = { jobs: of.length, min: Math.round(of.reduce((s, a) => s + a.min, 0) * 10) / 10 }
  }
  const sum = (key) => agents.reduce((s, a) => s + a[key], 0)
  const count = (r) => (byRole[r] ? byRole[r].jobs : 0)
  return {
    run: wfDir.split('/').pop(), slug: first._slug, mode: first._mode, round: first._round, version: versionOf(first._scripts, end), size,
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), wallMin: min(end - start),
    agentMin: Math.round(sum('min') * 10) / 10, agents: agents.length, pmTurns: count('pm'),
    devJobs: new Set(agents.filter((a) => a.role === 'lead' || a.role === 'dev').map((a) => a.id.replace(/[a-cm]$/, ''))).size, devMembers: agents.filter((a) => /^J\d+[a-c]$/.test(a.id)).length, testerJobs: count('tester'), retests: Math.max(0, count('tester') - 1), serversByHand: sum('byHand'), byRole,
    tokens: { outK: k(sum('out')), freshInK: k(sum('fresh')), cacheReadM: Math.round(sum('cacheRead') / 1e5) / 10 },
    jobs: agents.map(({ _t0, _t1, _slug, _mode, _round, _scripts, label: _l, out, fresh, cacheRead, peak, ...a }) => ({
      ...a, outK: k(out), freshInK: k(fresh), cacheReadM: Math.round(cacheRead / 1e4) / 100, peakK: k(peak),
    })),
  }
}
const json2 = (s) => { try { return JSON.parse(s) } catch { return null } }

// Every tf run launched from this workspace (or a sub-folder), oldest first.
export function runsOf(rootArg, { slug = '', days = 0 } = {}) {
  const root = resolve(rootArg)
  const enc = root.replace(/[^A-Za-z0-9]/g, '-')
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const cutoff = days ? Date.now() - days * 86_400_000 : 0
  const out = []
  for (const p of ls(base).filter((d) => d === enc || d.startsWith(`${enc}-`))) {
    for (const s of ls(join(base, p))) {
      const wfs = join(base, p, s, 'subagents', 'workflows')
      for (const w of ls(wfs)) {
        if (!w.startsWith('wf_')) continue
        const r = run(join(wfs, w))
        if (r && (!slug || r.slug.toLowerCase() === slug.toLowerCase()) && Date.parse(r.end) >= cutoff) out.push(r)
      }
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1))
}

const pad = (s, n) => String(s).padEnd(n)
const roleCols = (r) => ROLES.map((x) => pad(r.byRole[x] ? `${r.byRole[x].min}` : '-', 6)).join('')
function printRuns(runs) {
  console.log(`${pad('task', 10)}${pad('mode', 9)}${pad('rd', 3)}${pad('ver', 8)}${pad('size', 5)}${pad('start', 18)}${pad('wall', 6)}${ROLES.map((x) => pad(x.slice(0, 5), 6)).join('')}${pad('jobs', 5)}${pad('retest', 7)}${pad('byHand', 7)}outK  cacheM`)
  for (const r of runs) {
    console.log(`${pad(r.slug, 10)}${pad(r.mode, 9)}${pad(r.round, 3)}${pad(r.version, 8)}${pad(r.size || '-', 5)}${pad(r.start.slice(0, 16).replace('T', ' '), 18)}${pad(r.wallMin, 6)}${roleCols(r)}${pad(r.agents, 5)}${pad(r.retests, 7)}${pad(r.serversByHand, 7)}${pad(r.tokens.outK, 6)}${r.tokens.cacheReadM}`)
  }
}
function printJobs(r) {
  console.log(`\n${r.run} · ${r.slug} ${r.mode} r${r.round} · tf ${r.version} · size ${r.size || '-'} · wall ${r.wallMin} min · agent-min ${r.agentMin}`)
  for (const j of r.jobs) {
    console.log(`  ${j.start.slice(11, 16)} ${pad(j.id, 6)}${pad(j.role, 9)}${pad(j.repo, 5)}${pad(j.model, 12)}${pad(`${j.min}m`, 7)}tools ${pad(`${j.toolMin}m`, 7)}model ${pad(`${j.modelMin}m`, 7)}turns ${pad(j.turns, 4)}out ${pad(`${j.outK}k`, 6)}peak ${j.peakK}k`)
    for (const c of j.slowest) console.log(`        ${pad(`${c.sec}s`, 6)}${c.tool}: ${c.what.slice(0, 110)}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(n)
  const val = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : '')
  const pos = argv.filter((x, i) => !x.startsWith('--') && !['--days', '--run'].includes(argv[i - 1]))
  const root = pos[0]
  if (!root || (!pos[1] && !flag('--all'))) {
    console.error('usage: metrics.mjs <root> <slug> [--last | --run wf_<id>] [--json]  |  metrics.mjs <root> --all [--days 30] [--json]')
    process.exit(2)
  }
  if (flag('--all')) {
    const runs = runsOf(root, { days: Number(val('--days')) || 30 })
    if (flag('--json')) console.log(JSON.stringify(runs.map(({ jobs, ...r }) => r), null, 2))
    else if (!runs.length) console.log('no tf runs found for this workspace')
    else printRuns(runs)
    process.exit(0)
  }
  let runs = runsOf(root, { slug: pos[1] })
  if (!runs.length) { console.log(`no tf runs found for ${pos[1]}`); process.exit(0) }
  // Keep the whole history in the task folder (it survives the transcripts being pruned).
  const dir = [join(resolve(root), '.pipeline', runs[0].slug), join(resolve(root), '.pipeline', '_archive', runs[0].slug)].find(existsSync)
  if (dir && !flag('--json')) {
    const file = join(dir, 'metrics.json')
    const kept = json(file, []).filter((x) => !runs.some((r) => r.run === x.run))
    try { writeFileSync(file, JSON.stringify([...kept, ...runs].sort((a, b) => (a.start < b.start ? -1 : 1)), null, 1)) } catch {}
  }
  if (val('--run')) runs = runs.filter((r) => r.run === val('--run'))
  else if (flag('--last')) runs = runs.slice(-1)
  if (flag('--json')) { console.log(JSON.stringify(runs, null, 2)); process.exit(0) }
  printRuns(runs)
  runs.forEach(printJobs)
  if (runs.length > 1) {
    const span = min(Date.parse(runs[runs.length - 1].end) - Date.parse(runs[0].start))
    const busy = Math.round(runs.reduce((s, r) => s + r.wallMin, 0) * 10) / 10
    console.log(`\n${runs.length} runs · first start → last end ${span} min · inside runs ${busy} min · between runs ${Math.round((span - busy) * 10) / 10} min`)
  }
}
