#!/usr/bin/env node
// task-flow task identity and folder lifecycle. Deterministic — the orchestrator calls this instead of
// letting a model invent slugs, so one ticket always maps to one folder and one worktree per repo.
//
//   resolve <root> <input> [--repos be,fe,mobile]
//       input = ticket key (proj-301, PROJ-301), PR URL, owner/repo#n, or free text.
//       Prints JSON: { slug, dir, created, restoredFromArchive, round, nextRound, status, mode, prs{},
//       worktrees{}, legacyDirs[], legacyWorktrees[], format: 'current'|'old'|'new', locked }
//   lock <dir> [--ttl 5400]      → {"conflict":false} or {"conflict":true,"holder":…}
//   unlock <dir>
//   new-round <dir> <round>      archive plan/board/jobs of the previous round into history/r<round-1>/
//   journal <dir> <text…>        append "<ISO time> <text>" to journal.md
//   handoff-get <dir>            HANDOFF.md header as JSON
//   migrate-worktrees <root> [--apply]   move flat <slug>-<key> worktrees into .worktrees/<SLUG>/<repo dir>
//   legacy <root> [--repos a,b] [--apply]   fold old suffixed folders/worktrees into the ticket folder (dry run by default)

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_RE = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/
const LEGACY_SUFFIX = /-(?:e2e\d*|qc\d*|r\d+|evd|fix|review|view|verify|before|after|app|app-thumb|thumb|header)\b/i
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const git = (wt, args) => sh(`git -C ${q(wt)} ${args}`)
const gitOk = (wt, args) => { try { execSync(`git -C ${q(wt)} ${args}`, { stdio: 'pipe', shell: '/bin/sh', timeout: 30_000 }); return true } catch { return false } }
const sh = (cmd) => { try { return execSync(cmd, { stdio: 'pipe', shell: '/bin/sh', timeout: 30_000 }).toString().trim() } catch { return '' } }
const out = (o) => console.log(JSON.stringify(o, null, 2))

export function keyFrom(text) {
  const m = String(text || '').match(KEY_RE)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null
}

function prKey(input) {
  // https://github.com/o/r/pull/12 or o/r#12
  const m = String(input).match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/) || String(input).match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  if (!m) return null
  const [, owner, repo, num] = m
  const info = sh(`gh pr view ${num} --repo ${owner}/${repo} --json title,headRefName,body`)
  let key = null
  try {
    const j = JSON.parse(info)
    key = keyFrom(j.title) || keyFrom(j.headRefName) || keyFrom((j.body || '').slice(0, 2000))
  } catch {}
  return { key: key || `PR-${repo}-${num}`, url: `https://github.com/${owner}/${repo}/pull/${num}` }
}

function slugFromText(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-') || 'task'
}

export function header(dir) {
  const f = join(dir, 'HANDOFF.md')
  const h = { format: 'new', round: 0, status: '', mode: '', prs: {}, worktrees: {} }
  if (existsSync(f)) {
    h.format = 'current'
    for (const line of readFileSync(f, 'utf8').split('\n').slice(0, 40)) {
      let m
      if ((m = line.match(/^Round:\s*(\d+)/))) h.round = Number(m[1])
      else if ((m = line.match(/^Status:\s*([\w-]+)/))) h.status = m[1]
      else if ((m = line.match(/^Mode:\s*([\w-]+)/))) h.mode = m[1]
      else if ((m = line.match(/^PR\s+([\w-]+):\s*(\S+)/))) h.prs[m[1]] = m[2]
      else if ((m = line.match(/^Worktree\s+([\w-]+):\s*(\S+)/))) h.worktrees[m[1]] = m[2]
    }
    return h
  }
  const s = join(dir, 'STATUS.md')
  if (existsSync(s)) {
    // Old-layout folder (STATUS.md): round from the title, PRs from the State JSON.
    h.format = 'old'
    const txt = readFileSync(s, 'utf8')
    // Old STATUS files were often hand-edited: take the highest round mentioned anywhere.
    // Round numbers are small; "lượt này 2322k" / "tất cả lượt 4336k" are token counts, not rounds.
    const rounds = [...txt.matchAll(/(?:"round"\s*:\s*|\b(?:round|lượt|vòng)\s+)(\d{1,2})(?![\dk])/gi)].map((m) => Number(m[1]))
    h.round = rounds.length ? Math.max(...rounds) : 1
    const headLines = txt.split('\n').slice(0, 6).join('\n')
    h.status = /^(ESCALATE|HANDOFF|ERROR)/m.test(headLines) ? 'escalated' : 'done' // old-layout folders are historical: next run = new round
    const st = txt.match(/^State:\s*(\{.*\})\s*$/m)
    if (st) {
      try {
        const j = JSON.parse(st[1])
        for (const x of [...(j.history || []).flatMap((hh) => hh.results || []), ...(j.results || [])]) if (x.pr || x.mergedPr) h.prs[x.repo] = x.pr || x.mergedPr
        for (const r2 of (j.setup && j.setup.repos) || []) h.worktrees[r2.key] = r2.path
      } catch {}
    }
  }
  return h
}

function findDir(pipe, slug) {
  const want = slug.toLowerCase()
  const hits = { live: null, archived: null, legacy: [] }
  for (const base of [pipe, join(pipe, '_archive')]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const low = name.toLowerCase()
      const full = join(base, name)
      if (!statSync(full).isDirectory() || name.startsWith('_') && base === pipe) continue
      if (low === want) { if (base === pipe) hits.live = full; else hits.archived = full }
      else if (low.startsWith(`${want}-`) && LEGACY_SUFFIX.test(low.slice(want.length))) hits.legacy.push(full)
    }
  }
  return hits
}

// Repos from the workspace config table (| key | `path/` | …) → [{ key, dir }]; dir = the repo folder name.
export function repoMap(root, flag) {
  if (flag) return flag.split(',').filter(Boolean).map((x) => { const [key, dir] = x.split(':'); return { key, dir: dir || key } })
  const cfg = join(resolve(root), '.claude', 'task-flow.md')
  const out = []
  if (existsSync(cfg)) for (const m of readFileSync(cfg, 'utf8').matchAll(/^\|\s*([\w-]+)\s*\|\s*`([^`]+)`\s*\|/gm)) {
    if (m[1] === 'key' || m[1] === 'kind') continue
    out.push({ key: m[1], dir: m[2].replace(/\/+$/, '').split('/').pop() })
  }
  return out.length ? out : ['be', 'fe', 'mobile'].map((key) => ({ key, dir: key }))
}

function resolveTask(root, input, repos) {
  root = resolve(root)
  const pipe = join(root, '.pipeline')
  mkdirSync(pipe, { recursive: true })
  let slug = null
  let prUrl = null
  const pr = prKey(input)
  if (pr) { slug = pr.key; prUrl = pr.url } else slug = keyFrom(input) || slugFromText(input)
  const hits = findDir(pipe, slug)
  let dir = hits.live
  let restored = false
  let created = false
  if (!dir && hits.archived) {
    dir = join(pipe, slug)
    renameSync(hits.archived, dir)
    restored = true
  }
  if (!dir) { dir = join(pipe, slug); mkdirSync(dir, { recursive: true }); created = true }
  const h = header(dir)
  const closed = ['done', 'verified', 'reviewed'].includes(h.status)
  const nextRound = h.round === 0 ? 1 : closed ? h.round + 1 : h.round
  // Worktrees: canonical <root>/.worktrees/<SLUG>/<repo dir> (one folder per task, one subfolder per repo).
  // Old flat ones (<slug>-<key>) are still used when present and reported in oldLayout (task.mjs migrate-worktrees).
  const wtRoot = join(root, '.worktrees')
  const lower = slug.toLowerCase()
  const parentName = existsSync(wtRoot) ? readdirSync(wtRoot).find((n) => n.toLowerCase() === lower && !existsSync(join(wtRoot, n, '.git'))) : null
  const parent = join(wtRoot, parentName || slug)
  const worktrees = {}
  const worktreePaths = {}
  const oldLayout = []
  const legacyWorktrees = []
  for (const r of repos) {
    worktreePaths[r.key] = join(parent, r.dir)
    worktrees[r.key] = existsSync(join(parent, r.dir, '.git')) ? join(parent, r.dir) : null
  }
  if (existsSync(wtRoot)) {
    for (const name of readdirSync(wtRoot)) {
      const low = name.toLowerCase()
      if (!low.startsWith(`${lower}-`) || !existsSync(join(wtRoot, name, '.git'))) continue
      const rest = low.slice(lower.length + 1)
      const r = repos.find((x) => x.key === rest || x.dir.toLowerCase() === rest)
      if (r && !worktrees[r.key]) { worktrees[r.key] = join(wtRoot, name); oldLayout.push(join(wtRoot, name)) }
      else legacyWorktrees.push(join(wtRoot, name))
    }
  }
  const prs = { ...h.prs }
  if (prUrl && !Object.values(prs).includes(prUrl)) prs._input = prUrl
  let locked = false
  try { locked = Date.now() - statSync(join(dir, '.lock')).mtimeMs < 5_400_000 } catch {}
  return {
    slug, dir, created, restoredFromArchive: restored, format: h.format, round: h.round, nextRound,
    status: h.status, mode: h.mode, prs, worktrees, worktreePaths, worktreeParent: parent,
    oldLayout, legacyDirs: hits.legacy, legacyWorktrees, locked,
  }
}

function lock(dir, ttl = 5400) {
  mkdirSync(dir, { recursive: true })
  const f = join(dir, '.lock')
  if (existsSync(f)) {
    const age = (Date.now() - statSync(f).mtimeMs) / 1000
    if (age < ttl) return { conflict: true, holder: readFileSync(f, 'utf8').trim(), ageSec: Math.round(age) }
  }
  writeFileSync(f, JSON.stringify({ startedAt: Math.floor(Date.now() / 1000), pid: process.ppid }) + '\n')
  return { conflict: false }
}

function newRound(dir, round) {
  const prev = Number(round) - 1
  if (prev < 1) return { moved: [] }
  const dest = join(dir, 'history', `r${prev}`)
  const moved = []
  for (const f of ['plan.md', 'board.md', 'jobs', 'review.md', 'ticket-comment.md']) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    mkdirSync(dest, { recursive: true })
    const target = join(dest, f)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(p, target)
    moved.push(f)
  }
  return { moved, to: dest }
}

// Fold folders/worktrees created by earlier releases with suffixes (-e2e, -qc, -r2, …) into the one-folder-per-ticket
// layout. Dry run by default; --apply moves each legacy folder to <SLUG>/history/legacy/<name>/ (after freeing
// the resources it registered) and removes legacy worktrees that hold no uncommitted or unpushed work.
function legacy(root, repos, apply) {
  root = resolve(root)
  const pipe = join(root, '.pipeline')
  const S = dirname(fileURLToPath(import.meta.url))
  const plan = { folders: [], worktrees: [], skipped: [] }
  const scan = (base) => existsSync(base) ? readdirSync(base).filter((n) => !n.startsWith('_') && statSync(join(base, n)).isDirectory()).map((n) => ({ base, name: n })) : []
  for (const { base, name } of [...scan(pipe), ...scan(join(pipe, '_archive'))]) {
    const key = keyFrom(name)
    if (!key) { plan.skipped.push(`${name}: no ticket key`); continue }
    if (name.toLowerCase() === key.toLowerCase()) continue
    const rest = name.toLowerCase().slice(key.length)
    if (!rest.startsWith('-')) continue
    plan.folders.push({ from: join(base, name), key })
  }
  const wtRoot = join(root, '.worktrees')
  for (const name of existsSync(wtRoot) ? readdirSync(wtRoot) : []) {
    if (name.startsWith('_') || !existsSync(join(wtRoot, name, '.git'))) continue // task parent folders hold the new layout
    const key = keyFrom(name)
    if (!key) continue
    const rest = name.toLowerCase().slice(key.length + 1)
    if (repos.includes(rest)) continue
    const p = join(wtRoot, name)
    const dirty = sh(`git -C ${JSON.stringify(p)} status --porcelain`) ? 'uncommitted changes'
      : sh(`git -C ${JSON.stringify(p)} log --oneline -1 HEAD --not --remotes`) ? 'unpushed commits' : ''
    plan.worktrees.push({ path: p, key, keep: dirty })
  }
  if (!apply) return { dryRun: true, ...plan }
  const done = { moved: [], removed: [], kept: [] }
  const held = new Set()
  for (const f of plan.folders) {
    const ledger = join(f.from, 'resources.json')
    if (existsSync(ledger) && f.from.startsWith(pipe + '/') && !f.from.includes('/_archive/')) {
      sh(`node ${JSON.stringify(join(S, 'resources.mjs'))} release ${JSON.stringify(root)} ${JSON.stringify(f.from.split('/').pop())}`)
    }
    // Anything still registered (release failed, e.g. Docker down) stays tracked: keep the folder where the reaper sees it.
    let left = []
    try { left = JSON.parse(readFileSync(ledger, 'utf8')).entries || [] } catch {}
    if (left.length) {
      left.filter((e) => e.kind === 'worktree').forEach((e) => held.add(e.id))
      done.kept.push(`${f.from}: still holds ${left.map((e) => `${e.kind}:${String(e.id).split('/').pop()}`).join(', ')} — rerun when they can be freed`)
      continue
    }
    const live = join(pipe, f.key)
    const arch = join(pipe, '_archive', f.key)
    const canon = existsSync(live) ? live : existsSync(arch) ? arch : live
    const dest = join(canon, 'history', 'legacy', f.from.split('/').pop())
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) { done.kept.push(`${f.from}: ${dest} exists`); continue }
    renameSync(f.from, dest)
    done.moved.push(`${f.from} → ${dest}`)
  }
  for (const w of plan.worktrees) {
    if (w.keep) { done.kept.push(`${w.path}: ${w.keep}`); continue }
    if (held.has(w.path)) { done.kept.push(`${w.path}: registered by a kept folder`); continue }
    if (!existsSync(w.path)) continue
    const common = sh(`git -C ${JSON.stringify(w.path)} rev-parse --path-format=absolute --git-common-dir`).replace(/\/\.git$/, '')
    const r = sh(`git -C ${JSON.stringify(common)} worktree remove --force ${JSON.stringify(w.path)} && echo ok`)
    if (r.endsWith('ok')) done.removed.push(w.path); else done.kept.push(`${w.path}: remove failed`)
  }
  return done
}

// Move flat worktrees (<root>/.worktrees/<slug>-<key>) into the nested layout (<root>/.worktrees/<SLUG>/<repo dir>)
// with `git worktree move` (keeps uncommitted work), then rewrite the paths in every resources.json.
// Dry run unless --apply; refuses while any task run holds a lock.
function migrateWorktrees(root, repos, apply) {
  root = resolve(root)
  const wtRoot = join(root, '.worktrees')
  const pipe = join(root, '.pipeline')
  const plan = []
  const skipped = []
  for (const name of existsSync(wtRoot) ? readdirSync(wtRoot) : []) {
    const src = join(wtRoot, name)
    if (name.startsWith('_') || !existsSync(join(src, '.git'))) continue
    const key = keyFrom(name)
    const rest = key ? name.toLowerCase().slice(key.length + 1) : ''
    const r = repos.find((x) => x.key === rest || x.dir.toLowerCase() === rest)
    if (!key || !r) { skipped.push(`${name}: not <ticket>-<repo>`); continue }
    const dest = join(wtRoot, key, r.dir)
    if (existsSync(dest)) { skipped.push(`${name}: ${dest} exists`); continue }
    plan.push({ src, dest })
  }
  if (!apply) return { dryRun: true, moves: plan, skipped }
  const locked = existsSync(pipe) && readdirSync(pipe).some((n) => { try { return Date.now() - statSync(join(pipe, n, '.lock')).mtimeMs < 5_400_000 } catch { return false } })
  if (locked) return { applied: false, reason: 'a task run holds a lock — retry when no run is active' }
  const moved = []
  for (const m of plan) {
    mkdirSync(dirname(m.dest), { recursive: true })
    const common = sh(`git -C ${JSON.stringify(m.src)} rev-parse --path-format=absolute --git-common-dir`).replace(/\/\.git$/, '')
    const ok = sh(`git -C ${JSON.stringify(common)} worktree move ${JSON.stringify(m.src)} ${JSON.stringify(m.dest)} && echo ok`).endsWith('ok')
    if (ok) moved.push(m); else skipped.push(`${m.src}: git worktree move failed`)
  }
  // Rewrite ledger paths (live tasks, archive, legacy history copies).
  const ledgers = []
  const walk = (d, depth) => {
    if (depth > 5 || !existsSync(d)) return
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (n === 'resources.json') ledgers.push(p)
      else if (statSync(p).isDirectory() && !['evd', 'flows', 'node_modules', 'jobs'].includes(n)) walk(p, depth + 1)
    }
  }
  walk(pipe, 0)
  let rewritten = 0
  for (const f of ledgers) {
    const before = readFileSync(f, 'utf8')
    let txt = before
    for (const m of moved) txt = txt.split(m.src).join(m.dest)
    if (txt !== before) { writeFileSync(f, txt); rewritten++ }
  }
  return { applied: true, moved, skipped, ledgersRewritten: rewritten }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [cmd, ...a] = process.argv.slice(2)
  const flag = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a.splice(i, 2)[1] : d }
  try {
    switch (cmd) {
      case 'resolve': {
        const repos = repoMap(a[0], flag('repos'))
        out(resolveTask(a[0], a.slice(1).join(' '), repos))
        break
      }
      case 'lock': out(lock(resolve(a[0]), Number(flag('ttl', 5400)))); break
      case 'unlock': rmSync(join(resolve(a[0]), '.lock'), { force: true }); out({ unlocked: true }); break
      case 'new-round': out(newRound(resolve(a[0]), a[1])); break
      case 'journal': {
        const dir = resolve(a[0])
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, 'journal.md'), `${new Date().toISOString()} ${a.slice(1).join(' ')}\n`)
        out({ ok: true })
        break
      }
      case 'handoff-get': out(header(resolve(a[0]))); break
      // Dev jobs never commit (the reviewer packages). `head` is what a dev job reports before and after its
      // work; `uncommit` turns commits a dev job made back into uncommitted changes — nothing is lost.
      case 'head': out({ head: git(resolve(a[0]), 'rev-parse HEAD') }); break
      case 'uncommit': {
        const wt = resolve(a[0]); const sha = a[1] || ''
        const head = git(wt, 'rev-parse HEAD')
        if (!/^[0-9a-f]{7,40}$/.test(sha) || !head) throw new Error('usage: task.mjs uncommit <worktree> <sha before the job>')
        if (head.startsWith(sha) || sha.startsWith(head)) { out({ undone: 0, head }); break }
        if (!gitOk(wt, `merge-base --is-ancestor ${sha} HEAD`)) throw new Error(`refused: ${sha} is not an ancestor of HEAD — the branch moved, undo by hand`)
        if (git(wt, 'branch -r --contains HEAD')) throw new Error('refused: the commits are already pushed — leave them, tell the PM')
        const n = Number(git(wt, `rev-list --count ${sha}..HEAD`)) || 0
        if (!gitOk(wt, `reset -q ${sha}`)) throw new Error('git reset failed')
        out({ undone: n, head: git(wt, 'rev-parse HEAD') })
        break
      }
      case 'migrate-worktrees': {
        const r0 = a.filter((x) => x !== '--apply')[0]
        out(migrateWorktrees(r0, repoMap(r0, flag('repos')), a.includes('--apply')))
        break
      }
      case 'legacy': {
        const apply = a.includes('--apply')
        const r0 = a.filter((x) => x !== '--apply')[0]
        out(legacy(r0, repoMap(r0, flag('repos')).map((x) => x.key), apply))
        break
      }
      default:
        console.error('usage: task.mjs resolve <root> <input> [--repos a,b] | lock <dir> | unlock <dir> | new-round <dir> <n> | journal <dir> <text> | handoff-get <dir> | head <worktree> | uncommit <worktree> <sha> | legacy <root> [--apply]')
        process.exit(1)
    }
  } catch (e) {
    console.error(String(e && e.message || e))
    process.exit(1)
  }
}
