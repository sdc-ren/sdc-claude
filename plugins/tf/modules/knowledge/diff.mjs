// tf knowledge — the contract diff of one task: what its worktrees change in the routes, their guards and
// validators, the calls to them and the socket events, against where the task branched from.
//
//   tf knowledge diff <root> --task <SLUG> [--out <file>]
//
// A repo with a worktree for the task (.worktrees/<SLUG>/<repo folder>, as task.mjs resolve names it): the task
// side is the worktree as it is now (edits not committed, new files included); the base side is the merge-base of
// its HEAD with origin/<base> — the way a PR compares, so a route the base branch added after the task branched is
// not reported as removed. A repo without one: both sides are origin/<base>, and its calls still count (a client
// that calls a route the task removes is a broken caller even if that client is not in the task).
//
// Exit: 0 no contract change · 3 a change (read the report) · 4 a caller the change breaks, or a new call that
// reaches no route.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { knowledgeOf, readConfig } from '../../core/config.mjs'
import { repoMap } from '../task/task.mjs'
import { detect } from './detect.mjs'
import { contractModel, join as joinCalls } from './providers/contracts.mjs'
import { samePath } from './scan.mjs'
import { openAt, openRepo, openWorktree } from './source.mjs'

const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', windowsHide: true }).toString().trim() } catch { return '' } }
const key = (r) => `${r.method} ${r.path}`
const list = (xs) => [...new Set(xs)].sort().join(', ')

/** The readers of both sides, per repo, and how each side was chosen. */
export function sides(rootIn, slug) {
  const root = resolve(rootIn)
  const p = detect(root)
  const dirs = Object.fromEntries(repoMap(root).map((r) => [r.key, r.dir]))
  return p.repos.map((r) => {
    const wt = join(root, '.worktrees', slug, dirs[r.key] || r.path.replace(/\/+$/, ''))
    if (existsSync(join(wt, '.git'))) {
      const head = git(wt, ['rev-parse', 'HEAD'])
      const mb = r.base ? git(wt, ['merge-base', 'HEAD', `origin/${r.base}`]) : ''
      const rev = mb || head
      return { key: r.key, inTask: true, base: openAt(wt, rev, `merge-base ${rev.slice(0, 10)}`), task: openWorktree(wt), worktree: wt }
    }
    const reader = openRepo(r.abs, r.base)
    return { key: r.key, inTask: false, base: reader, task: reader }
  })
}

export function contractDiff(rootIn, slug) {
  const root = resolve(rootIn)
  const knowledge = knowledgeOf(readConfig(root))
  const s = sides(root, slug)
  const before = contractModel(s.map((x) => ({ key: x.key, reader: x.base })), knowledge)
  const after = contractModel(s.map((x) => ({ key: x.key, reader: x.task })), knowledge)
  const B = new Map(before.routes.map((r) => [key(r), r])), A = new Map(after.routes.map((r) => [key(r), r]))
  const added = [...A.keys()].filter((k) => !B.has(k)).map((k) => A.get(k))
  const removed = [...B.keys()].filter((k) => !A.has(k)).map((k) => B.get(k))
  const changed = [...A.keys()].filter((k) => B.has(k)).map((k) => ({ before: B.get(k), after: A.get(k) }))
    .filter(({ before: b, after: a }) => list(b.guards) !== list(a.guards) || list(b.validators) !== list(a.validators))
  // Callers a removed route leaves behind: calls of the task side that matched it and now reach nothing.
  const jA = joinCalls(after, knowledge), jB = joinCalls(before, knowledge)
  const reaches = new Set(jA.orphans)
  const broken = removed.flatMap((r) => after.calls.filter((c) => reaches.has(c) && (c.method === r.method || c.method === 'ANY' || r.method === 'ANY') && samePath(c.path, r.path)).map((c) => ({ route: r, call: c })))
  const ck = (c) => `${c.repo} ${c.method} ${c.path}`
  const oldOrphans = new Set(jB.orphans.map(ck))
  const newOrphans = jA.orphans.filter((c) => !oldOrphans.has(ck(c)) && !broken.some((b) => b.call === c))
  const callsB = new Set(before.calls.map(ck)), callsA = new Set(after.calls.map(ck))
  const callsAdded = after.calls.filter((c) => !callsB.has(ck(c)))
  const callsRemoved = before.calls.filter((c) => !callsA.has(ck(c)))
  const ev = (m, dir) => new Set(m.sockets.filter((x) => x.dir === dir).map((x) => x.event))
  const evAdded = ['emit', 'on'].flatMap((d) => [...ev(after, d)].filter((e) => !ev(before, d).has(e)).map((e) => `${d} ${e}`))
  const evRemoved = ['emit', 'on'].flatMap((d) => [...ev(before, d)].filter((e) => !ev(after, d).has(e)).map((e) => `${d} ${e}`))
  const any = added.length + removed.length + changed.length + callsAdded.length + callsRemoved.length + evAdded.length + evRemoved.length
  const code = broken.length || newOrphans.length ? 4 : any ? 3 : 0
  return { code, sides: s.map((x) => ({ key: x.key, inTask: x.inTask, base: x.base.ref, task: x.task.ref })), added, removed, changed, broken, newOrphans, callsAdded, callsRemoved, evAdded, evRemoved }
}

export function render(slug, d) {
  const r = (x) => `**${x.method}** \`${x.path}\` — ${x.repo} \`${x.at}\``
  const c = (x) => `**${x.method}** \`${x.path}\` — ${x.repo} \`${x.fn || '?'}\` \`${x.at}\``
  const sec = (title, items, fmt) => [`## ${title} (${items.length})`, '', ...(items.length ? items.map((x) => `- ${fmt(x)}`) : ['_None._']), '']
  return [
    `# Contract diff — ${slug}`, '',
    `Verdict: ${d.code === 4 ? '**a caller breaks or a new call reaches no route**' : d.code === 3 ? 'the contract changes — check each line' : 'no contract change'}.`, '',
    '| repo | base side | task side |', '|---|---|---|',
    ...d.sides.map((s) => `| ${s.key} | \`${s.base}\` | ${s.inTask ? `\`${s.task}\`` : '(not in the task)'} |`), '',
    ...sec('Callers this change breaks', d.broken, (b) => `${c(b.call)} still calls the removed ${r(b.route)}`),
    ...sec('New calls that reach no route', d.newOrphans, c),
    ...sec('Routes added', d.added, r),
    ...sec('Routes removed', d.removed, r),
    ...sec('Guards or validators changed', d.changed, (x) => `${r(x.after)}: guards ${list(x.before.guards) || '—'} → ${list(x.after.guards) || '—'}; validators ${list(x.before.validators) || '—'} → ${list(x.after.validators) || '—'}`),
    ...sec('Calls added', d.callsAdded, c),
    ...sec('Calls removed', d.callsRemoved, c),
    ...sec('Socket events added', d.evAdded, (x) => `\`${x}\``),
    ...sec('Socket events removed', d.evRemoved, (x) => `\`${x}\``),
    'Read by text, not run: a route or a call built in a way tf does not follow is not here. Check what matters in the code.', '',
  ].join('\n')
}

export function diffCli(root, slug, out) {
  const d = contractDiff(root, slug)
  const text = render(slug, d)
  const file = out ? resolve(root, out) : ''
  if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  else process.stdout.write(text)
  const n = (x) => x.length
  console.log(`${out ? `contract diff → ${out}: ` : ''}${n(d.broken)} broken caller(s), ${n(d.newOrphans)} new unmatched call(s), ${n(d.added)} route(s) added, ${n(d.removed)} removed, ${n(d.changed)} changed (exit ${d.code})`)
  return d.code
}
