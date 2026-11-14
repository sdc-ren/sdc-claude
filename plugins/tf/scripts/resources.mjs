#!/usr/bin/env node
// task-flow resource registry. One file per task: <root>/.pipeline/<slug>/resources.json.
// Every resource a task holds is an entry with the exact commands that free it, so cleanup
// never guesses and never touches another session's resources.
//
//   add <root> <slug> --kind K --id ID --release CMD [--stop CMD] [--when run-end|pr-merged]
//   drop <root> <slug> --kind K --id ID         remove an entry without running anything
//   prs <root> <slug> <pr-url>...               PRs whose merge frees the task
//   taken <root> <kind>                         ids of <kind> held by any task (one per line)
//   end-run <root> <slug>                       run every `stop`, release + drop `run-end` entries
//   release <root> <slug>                       release everything now (manual cleanup / verify-only)
//   reap [--dry-run] [<root>...]                release tasks whose PRs are all merged or closed, then
//                                               move .pipeline/<slug> to .pipeline/_archive/<slug>
//   archive <root> <slug>                       move a finished task folder to .pipeline/_archive/
//   prune [--days 7] [--dry-run] [<root>...]    tasks idle longer than N days: free their resources; delete the
//                                               folder when no PR is still open (else keep only the text handoff
//                                               files); delete old _archive entries and stray clean worktrees
//   promote <root> <slug>                       copy the task's passing flows into .pipeline/_regression/ (reap does it on merge)
//   list [<root>...]                            print what every task holds (the only resource ledger)
//   register-root <root>                        add a workspace to the reaper's list
//   restore-touched <root> <worktree>           put back the files tools rewrite on their own (config
//                                               "## Tool-touched files"); done automatically before a worktree is freed
//
// `when`: run-end = browsers, emulators (freed when a run stops); pr-merged = worktrees, DB clones,
// cache dbs, ports (kept for review fixes, freed by `reap` once every PR is merged/closed).
// A worktree with uncommitted or unpushed work is never removed; it stays flagged for the user.
// PRs: full URL or `owner/repo#n`. A task with no registered PR gets them from its worktrees' branches.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, appendFileSync, renameSync, statSync, copyFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SH, stateDir } from './platform.mjs'

const HOME_DIR = stateDir()
const ROOTS = join(HOME_DIR, 'roots.txt')
const LOG = join(HOME_DIR, 'reap.log')

const fileOf = (root, slug) => join(root, '.pipeline', slug, 'resources.json')
const stamp = () => new Date().toISOString()
const say = (msg) => {
  console.log(msg)
  mkdirSync(HOME_DIR, { recursive: true })
  appendFileSync(LOG, `${stamp()} ${msg}\n`)
}

export function load(root, slug) {
  const f = fileOf(root, slug)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { slug, prs: [], entries: [] }
}
function save(root, slug, data) {
  mkdirSync(join(root, '.pipeline', slug), { recursive: true })
  writeFileSync(fileOf(root, slug), JSON.stringify(data, null, 2) + '\n')
}
function tasks(root) {
  const dir = join(root, '.pipeline')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((s) => !s.startsWith('_') && existsSync(fileOf(root, s)))
}
function run(cmd, root) {
  try {
    execSync(cmd, { cwd: root, stdio: 'pipe', shell: SH, windowsHide: true, timeout: 120_000 })
    return true
  } catch (e) {
    say(`  ! failed: ${cmd} — ${String(e.stderr || e.message).trim().split('\n')[0]}`)
    return false
  }
}

export function add(root, slug, entry) {
  const d = load(root, slug)
  d.entries = d.entries.filter((e) => !(e.kind === entry.kind && e.id === entry.id))
  d.entries.push({ when: 'pr-merged', ...entry, since: stamp() })
  save(root, slug, d)
}
export function drop(root, slug, kind, id) {
  const d = load(root, slug)
  d.entries = d.entries.filter((e) => !(e.kind === kind && e.id === id))
  save(root, slug, d)
}
export function taken(root, kind) {
  return tasks(root).flatMap((s) => load(root, s).entries.filter((e) => e.kind === kind).map((e) => e.id))
}

const sh = (cmd, cwd) => {
  try { return execSync(cmd, { cwd, stdio: 'pipe', shell: SH, windowsHide: true }).toString().trim() } catch { return '' }
}
// Files the workspace config lists under "## Tool-touched files": tools rewrite them on their own
// (`flutter pub get` adds exclude lines to analysis_options.yaml, an IDE re-sorts a lockfile…). They are
// never part of a change, so a worktree whose only edits are in them holds no work.
export function toolTouched(root) {
  const cfg = join(root, '.claude', 'task-flow.md')
  if (!existsSync(cfg)) return []
  const txt = readFileSync(cfg, 'utf8')
  const i = txt.search(/^## Tool-touched files\b/m)
  if (i < 0) return []
  const body = txt.slice(i).split('\n').slice(1)
  const end = body.findIndex((l) => /^## /.test(l))
  return (end < 0 ? body : body.slice(0, end)).map((l) => (l.match(/^\s*-\s*`([^`]+)`/) || [])[1]).filter(Boolean).map((p) => p.replace(/^\.\//, ''))
}
// Put the listed files back as committed when a tool changed them (tracked and modified only — a new or
// staged file is somebody's work). Returns the files restored.
export function restoreTouched(root, path) {
  const list = toolTouched(root)
  if (!list.length || !existsSync(path)) return []
  const done = []
  // `git diff --name-only`: tracked files with unstaged edits — exactly what a tool leaves behind.
  for (const file of sh('git diff --name-only', path).split(/\r?\n/).filter(Boolean)) {
    if (list.includes(file)) { sh(`git checkout -- ${JSON.stringify(file)}`, path); done.push(file) }
  }
  return done
}
// Uncommitted changes, or commits not on the remote branch → the worktree holds work nobody else has.
function unsavedWork(path, root) {
  if (!existsSync(path)) return ''
  if (root) restoreTouched(root, path)
  if (sh('git status --porcelain', path)) return 'uncommitted changes'
  if (sh('git log --oneline -1 HEAD --not --remotes', path)) return 'unpushed commits'
  return ''
}

// Release entries matching `pick`; keep the ones whose command failed so nothing leaks silently.
function releaseWhere(root, slug, pick) {
  const d = load(root, slug)
  const keep = []
  let failed = 0
  for (const e of d.entries) {
    if (!pick(e)) { keep.push(e); continue }
    const why = e.kind === 'worktree' ? unsavedWork(e.id, root) : ''
    if (why) { say(`  keep ${slug} worktree ${e.id}: ${why}`); keep.push({ ...e, error: why }); failed++; continue }
    say(`  release ${slug} ${e.kind} ${e.id}`)
    if (!run(e.release, root)) { keep.push({ ...e, error: true }); failed++ }
  }
  d.entries = keep
  if (!keep.length && pick({ when: 'pr-merged' })) rmSync(fileOf(root, slug))
  else save(root, slug, d)
  return failed === 0 // true when everything asked for was released (entries not picked stay, and are not a failure)
}
export function endRun(root, slug) {
  for (const e of load(root, slug).entries) if (e.stop) run(e.stop, root)
  return releaseWhere(root, slug, (e) => e.when === 'run-end')
}
export function releaseAll(root, slug) {
  say(`release ${slug} @ ${root}`)
  return releaseWhere(root, slug, () => true)
}

function prState(ref) {
  const m = String(ref).match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) // owner/repo#n — gh pr view needs --repo for this form
  const cmd = m ? `gh pr view ${m[2]} --repo ${m[1]}` : `gh pr view ${JSON.stringify(ref)}`
  return sh(`${cmd} --json state -q .state`) || 'UNKNOWN'
}
// PRs opened from the task's worktree branches (any state) — for tasks that never registered theirs.
function prsFromWorktrees(d) {
  const urls = []
  for (const e of d.entries.filter((x) => x.kind === 'worktree' && existsSync(x.id))) {
    const b = sh('git branch --show-current', e.id)
    if (b) urls.push(...sh(`gh pr list --head ${JSON.stringify(b)} --state all --json url -q '.[].url'`, e.id).split('\n').filter(Boolean))
  }
  return [...new Set(urls)]
}
export function archive(root, slug) {
  const from = join(root, '.pipeline', slug)
  if (!existsSync(from) || existsSync(fileOf(root, slug))) return false // still holds resources
  const to = join(root, '.pipeline', '_archive', slug)
  mkdirSync(join(root, '.pipeline', '_archive'), { recursive: true })
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  renameSync(from, to)
  say(`archive ${slug} → .pipeline/_archive/`)
  return true
}
function roots(args) {
  if (args.length) return args.map((r) => resolve(r))
  return existsSync(ROOTS) ? readFileSync(ROOTS, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []
}
// When a task's PRs are merged, its passing e2e flows join the workspace regression suite
// (<root>/.pipeline/_regression/flows/<slug>-<case>.mjs + flows.json), runnable with flow-run.mjs.
export function promoteFlows(root, slug) {
  const dir = join(root, '.pipeline', slug)
  const mf = join(dir, 'flows.json')
  if (!existsSync(mf)) return 0
  let m
  try { m = JSON.parse(readFileSync(mf, 'utf8')) } catch { return 0 }
  const reg = join(root, '.pipeline', '_regression')
  const regMf = join(reg, 'flows.json')
  mkdirSync(join(reg, 'flows'), { recursive: true })
  const r = existsSync(regMf) ? JSON.parse(readFileSync(regMf, 'utf8')) : { targets: {}, cases: {} }
  r.targets ||= {}
  r.cases ||= {}
  let n = 0
  for (const [c, v] of Object.entries(m.cases || {})) {
    if (v.lastResult !== 'PASS' || !v.file || !existsSync(join(dir, v.file))) continue
    const id = `${slug}-${c}`
    copyFileSync(join(dir, v.file), join(reg, 'flows', `${id}.mjs`))
    r.cases[id] = { file: `flows/${id}.mjs`, platform: v.platform, source: slug, promotedAt: stamp(), lastResult: 'PASS' }
    n++
  }
  writeFileSync(regMf, JSON.stringify(r, null, 2) + '\n')
  if (n) say(`promote ${n} flow(s) of ${slug} → .pipeline/_regression/`)
  return n
}

export function reap(rootList, dryRun = false) {
  for (const root of rootList) {
    for (const slug of tasks(root)) {
      if (running(join(root, '.pipeline', slug))) continue // a run is in progress
      const d = load(root, slug)
      if (!d.prs.length) {
        const found = prsFromWorktrees(d)
        if (!found.length) continue // no PR yet (in progress, escalated, or a detached verify run — release by hand)
        d.prs = found
        if (!dryRun) save(root, slug, d)
      }
      const states = d.prs.map(prState)
      if (!states.every((s) => s === 'MERGED' || s === 'CLOSED')) continue
      if (dryRun) { console.log(`would reap ${slug}: ${d.entries.map((e) => `${e.kind} ${e.id}`).join(', ') || 'nothing held'}`); continue }
      say(`reap ${slug}: PRs ${states.join(',')}`)
      try { promoteFlows(root, slug) } catch (e) { say(`promote ${slug} failed: ${e.message}`) }
      if (releaseAll(root, slug)) archive(root, slug)
    }
  }
}

// Last activity of a task folder: newest file, ignoring the ledger itself and logs (both are touched by tooling).
function lastActivity(dir) {
  let newest = 0
  const walk = (d, depth) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue }
      if (f.name === 'resources.json' || f.name.endsWith('.log') || f.name === '.DS_Store') continue
      try { newest = Math.max(newest, statSync(p).mtimeMs) } catch {}
    }
  }
  try { walk(dir, 0) } catch {}
  return newest || statSync(dir).mtimeMs
}
// A run holds .lock; the workflow treats one older than 90 minutes as stale, and so do we.
const running = (dir) => { try { return Date.now() - statSync(join(dir, '.lock')).mtimeMs < 5_400_000 } catch { return false } }
// Text handoff files a later round needs (HANDOFF, journal, flows; old-layout folders: STATUS, spec). Evidence images,
// job reports, history and logs are heavy and regenerable.
const KEEP_WHEN_PR_OPEN = new Set(['HANDOFF.md', 'journal.md', 'flows', 'flows.json', 'plan.md', 'board.md', 'STATUS.md', 'spec.md', 'ticket.md', 'ticket-comment.md', 'resources.json', 'metrics.json'])
// Archived (all PRs merged/closed) tasks: slim to the handoff set after TF_PRUNE_DAYS, delete after this many days,
// so a QC report that arrives after the merge still finds HANDOFF.md and the flows.
const ARCHIVE_DAYS = Number(process.env.TF_ARCHIVE_DAYS || 30)
const days = (ms) => Math.floor((Date.now() - ms) / 86_400_000)

export function prune(rootList, maxDays = 7, dryRun = false) {
  const act = (msg, fn) => { if (dryRun) console.log(`would ${msg}`); else { say(msg); fn() } }
  for (const root of rootList) {
    const pipe = join(root, '.pipeline')
    if (!existsSync(pipe)) continue
    for (const slug of readdirSync(pipe)) {
      const dir = join(pipe, slug)
      if (slug.startsWith('_') || !statSync(dir).isDirectory() || running(dir)) continue
      const idle = days(lastActivity(dir))
      if (idle <= maxDays) continue
      const d = load(root, slug)
      if (d.entries.length) act(`free ${slug} (idle ${idle}d)`, () => releaseAll(root, slug))
      if (!dryRun && existsSync(fileOf(root, slug)) && load(root, slug).entries.length) continue // something was kept (unsaved work)
      const prs = d.prs.length ? d.prs : prsFromWorktrees(d)
      const open = prs.filter((u) => prState(u) === 'OPEN')
      if (open.length) {
        // A later QC round still needs the plan, ticket and state; everything heavy goes.
        act(`slim ${slug} (idle ${idle}d, PR open: ${open.join(' ')})`, () => {
          for (const f of readdirSync(dir)) if (!KEEP_WHEN_PR_OPEN.has(f)) rmSync(join(dir, f), { recursive: true, force: true })
        })
      } else {
        act(`delete ${slug} (idle ${idle}d, no open PR)`, () => rmSync(dir, { recursive: true, force: true }))
      }
    }
    const arch = join(pipe, '_archive')
    if (existsSync(arch)) for (const slug of readdirSync(arch)) {
      const dir = join(arch, slug)
      const idle = days(lastActivity(dir))
      if (idle > ARCHIVE_DAYS) act(`delete _archive/${slug} (idle ${idle}d)`, () => rmSync(dir, { recursive: true, force: true }))
      else if (idle > maxDays && readdirSync(dir).some((f) => !KEEP_WHEN_PR_OPEN.has(f))) {
        act(`slim _archive/${slug} (idle ${idle}d)`, () => {
          for (const f of readdirSync(dir)) if (!KEEP_WHEN_PR_OPEN.has(f)) rmSync(join(dir, f), { recursive: true, force: true })
        })
      }
    }
    // Worktrees no task ledger knows about: remove when clean, pushed, and idle; otherwise report.
    const wtRoot = join(root, '.worktrees')
    if (existsSync(wtRoot)) {
      const owned = new Set(tasks(root).flatMap((s) => load(root, s).entries.filter((e) => e.kind === 'worktree').map((e) => e.id)))
      // Layout: .worktrees/<SLUG>/<repo dir> (task parent folders) — older flat .worktrees/<slug>-<key> too.
      // .worktrees/_pool/* is the warm pool (pool.mjs) and never pruned.
      const candidates = []
      for (const name of readdirSync(wtRoot)) {
        const p = join(wtRoot, name)
        if (name.startsWith('_') || !statSync(p).isDirectory()) continue
        if (existsSync(join(p, '.git'))) candidates.push([name, p])
        else for (const sub of readdirSync(p)) if (existsSync(join(p, sub, '.git'))) candidates.push([`${name}/${sub}`, join(p, sub)])
      }
      for (const [name, wt] of candidates) {
        if (owned.has(wt)) continue
        const idle = days(statSync(wt).mtimeMs)
        if (idle <= maxDays) continue
        const why = unsavedWork(wt, root)
        if (why) { console.log(`stray worktree ${name} kept: ${why}`); continue }
        const common = sh('git rev-parse --path-format=absolute --git-common-dir', wt).replace(/[\\/]\.git$/, '')
        act(`remove stray worktree ${name} (idle ${idle}d)`, () => run(`git -C ${JSON.stringify(common)} worktree remove --force ${JSON.stringify(wt)}`, root))
      }
      // Empty task parent folders left after their worktrees were freed.
      if (!dryRun) for (const name of readdirSync(wtRoot)) {
        const p = join(wtRoot, name)
        if (name.startsWith('_') || !statSync(p).isDirectory() || existsSync(join(p, '.git'))) continue
        const holdsWorktree = readdirSync(p).some((sub) => existsSync(join(p, sub, '.git')))
        // Empty task folder, or leftovers (e.g. a dev server's vite cache) written after the worktree was removed.
        if (!holdsWorktree && (!readdirSync(p).length || days(statSync(p).mtimeMs) > maxDays)) rmSync(p, { recursive: true, force: true })
      }
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const flags = {}
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
    else pos.push(rest[i])
  }
  const [root, slug] = [pos[0] && resolve(pos[0]), pos[1]]
  switch (cmd) {
    case 'restore-touched': console.log(JSON.stringify({ restored: restoreTouched(root, resolve(pos[1] || '.')) })); break
    case 'add':
      if (!flags.kind || !flags.id || !flags.release) throw new Error('add needs --kind --id --release')
      add(root, slug, { kind: flags.kind, id: flags.id, release: flags.release, ...(flags.stop && { stop: flags.stop }), when: flags.when || 'pr-merged' })
      break
    case 'drop': drop(root, slug, flags.kind, flags.id); break
    case 'prs': { const d = load(root, slug); d.prs = [...new Set([...d.prs, ...pos.slice(2)])]; save(root, slug, d); break }
    case 'taken': console.log(taken(root, slug).join('\n')); break
    case 'end-run': process.exitCode = endRun(root, slug) ? 0 : 1; break
    case 'promote': console.log(promoteFlows(root, slug)); break
    case 'release': process.exitCode = releaseAll(root, slug) ? 0 : 1; break
    case 'reap': {
      const dry = process.argv.includes('--dry-run')
      const list = roots(process.argv.slice(3).filter((a) => a !== '--dry-run'))
      reap(list, dry)
      prune(list, Number(process.env.TF_PRUNE_DAYS || 7), dry) // the launchd job runs `reap`, so pruning rides along
      break
    }
    case 'prune': {
      const a = process.argv.slice(3)
      const i = a.indexOf('--days')
      const n = i >= 0 ? Number(a.splice(i, 2)[1]) : 7
      const dry = a.includes('--dry-run')
      prune(roots(a.filter((x) => x !== '--dry-run')), n, dry)
      break
    }
    case 'archive': process.exitCode = archive(root, slug) ? 0 : 1; break
    case 'list':
      for (const r of roots(pos)) for (const s of tasks(r)) {
        const d = load(r, s)
        console.log(`${r} · ${s} · PRs: ${d.prs.join(' ') || '-'}`)
        for (const e of d.entries) console.log(`   ${e.kind} ${e.id} (${e.when})${e.error ? ` KEPT: ${e.error === true ? 'release failed' : e.error}` : ''}`)
      }
      break
    case 'register-root': {
      mkdirSync(HOME_DIR, { recursive: true })
      const list = new Set(roots([]))
      list.add(root)
      writeFileSync(ROOTS, [...list].join('\n') + '\n')
      break
    }
    default:
      console.error('usage: resources.mjs add|drop|prs|taken|end-run|release|reap [--dry-run]|prune [--days N] [--dry-run]|archive|list|register-root …')
      process.exitCode = 2
  }
}
