// The executor's hard rules, run against mock agents: no model, no git, no files. Each scenario scripts the
// PM's decisions and what every job answers, then checks how the run ended and which jobs ran.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import assert from 'node:assert/strict'
import { test } from 'node:test'

// Run: node --test tests/engine.mjs   (plain Node: `claude plugin test` only loads hooks-module tests)
const has = (a, b) => (Array.isArray(a) ? a.includes(b) : String(a).includes(b))
const expect = (a) => ({
  toBe: (b) => assert.equal(a, b),
  toEqual: (b) => assert.deepEqual(a, b),
  toContain: (b) => assert.ok(has(a, b), `expected ${JSON.stringify(a)} to contain ${JSON.stringify(b)}`),
  not: { toContain: (b) => assert.ok(!has(a, b), `expected ${JSON.stringify(a)} not to contain ${JSON.stringify(b)}`) },
})

// Two forms of the same engine, both tested: the Workflow bundle Claude Code runs (engine/task-flow.js, the
// runtime as globals) and the ES module other hosts import (engine/src/flow.mjs, the runtime passed in).
// TF_ENGINE=src runs every scenario on the module.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'task-flow.js'), 'utf8').replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const { taskFlow } = await import('../engine/src/flow.mjs')
const runEngine = process.env.TF_ENGINE === 'src'
  ? (args, agent, parallel, phase, log, budget) => taskFlow(args, { agent, parallel, phase, log, budget })
  : (args, agent, parallel, phase, log, budget) => new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', 'budget', src)(args, agent, parallel, phase, log, budget)



const J = (id, role, repo, group, brief = 'x', model = 'sonnet', cases = '') => ({ id, role, repo, model, group, brief, doneWhen: 'd', ...(cases ? { cases } : {}) })
const ok = (verdict, extra = {}) => ({ status: 'done', verdict, summary: 's', ...extra })
const D = (jobs, size = 'M') => ({ decision: 'dispatch', size, note: 'n', scope: 'be changed', jobs })
const close = { decision: 'close', size: 'M', note: 'n', close: { summary: 's' } }
const escalate = { decision: 'escalate', size: 'M', note: 'n', escalate: 'stop' }
const solo = { split: false, status: 'done', verdict: 'NONE', summary: 'did', headBefore: 'aaaaaaa1', headAfter: 'aaaaaaa1' }
const std = (label) =>
  label === 'J0 reviewer:plan' ? ok('SHIP') : label.includes('lead') ? solo : label.includes('reviewer') ? ok('SHIP', { prUrl: 'https://x/pr/1' }) : label.includes('tester') ? ok('PASS') : ok('NONE')

async function sim(pm, answer = std, extra = {}) {
  let turn = 0
  const ran = []
  const logs = []
  const prompts = {}
  const pmPrompts = []
  const pmModels = []
  const agent = async (prompt, o) => {
    if (/^PM t/.test(o.label)) { pmPrompts.push(prompt); pmModels.push(o.model); return pm[turn++] }
    ran.push(`${o.label}(${o.model})`)
    prompts[o.label] = prompt
    return answer(o.label, prompt)
  }
  const args = { root: '/r', slug: 'T-1', dir: '/r/.pipeline/T-1', scripts: '/s', config: '/c', mode: 'build', worktreePaths: { be: '/wt/be', fe: '/wt/fe', mobile: '/wt/mobile' }, ...extra }
  const parallel = (fns) => Promise.all(fns.map(f => f()))
  const budget = { total: 0, remaining: () => 1e9, spent: () => 0 }
  const out = await runEngine(args, agent, parallel, () => {}, (m) => logs.push(m), budget)
  return { out, ran, logs, prompts, pmPrompts, pmModels }
}

const gates = (repos, g, n) => repos.map((r, i) => J(`J${n + i}`, 'reviewer', r, g))
const oneRepo = D([J('J1', 'dev', 'be', 1), J('J2', 'reviewer', 'be', 2), J('J3', 'tester', 'be', 3)])
const withCases = [J('J1', 'dev', 'be', 1), J('J2', 'reviewer', 'be', 2), J('J3', 'tester', 'be', 3, 'x', 'sonnet', 'C2, C5')]
const pack = (n, repos = ['be']) => D(repos.map((r, i) => J(`J${n + i}`, 'reviewer', r, 1, 'PACKAGE')))

test('close is judged per repo: a later fix on another repo does not undo a tested one', async () => {
  const pm = [
    D([J('J1', 'dev', 'be', 1, 'x', 'opus'), J('J2', 'dev', 'mobile', 1), ...gates(['be', 'mobile'], 2, 3), J('J5', 'tester', 'be', 3), J('J6', 'tester', 'mobile', 3)]),
    D([J('J7', 'dev', 'mobile', 1), J('J8', 'reviewer', 'mobile', 2, 'x', 'haiku'), J('J9', 'tester', 'mobile', 3)]),
    pack(10, ['be', 'mobile']), close]
  const r = await sim(pm, l => (l === 'J6 tester:mobile' ? ok('FAIL', { issues: ['IB1'] }) : std(l)))
  expect(r.out.status).toBe('done')
  // the gate runs on the model of the repo's dev lead, whatever the PM wrote
  expect(r.ran).toContain('J3 reviewer:be(opus)')
  expect(r.ran).toContain('J8 reviewer:mobile(sonnet)')
})

test('a security-sensitive change is gated on opus while its dev keeps sonnet', async () => {
  const pm = [
    D([{ ...J('J1', 'dev', 'be', 1), sensitive: true }, J('J2', 'dev', 'fe', 1), ...gates(['be', 'fe'], 2, 3), J('J5', 'tester', 'be', 3), J('J6', 'tester', 'fe', 3)]),
    pack(7, ['be', 'fe']), close]
  const r = await sim(pm)
  expect(r.out.status).toBe('done')
  expect(r.ran).toContain('J1 lead:be(sonnet)')
  expect(r.ran).toContain('J3 reviewer:be(opus)')
  expect(r.ran).toContain('J4 reviewer:fe(sonnet)')
  expect(r.logs.join('\n')).toContain('opus (security-sensitive change)')
})

test('a repo tested before its own last dev job cannot close', async () => {
  const r = await sim([oneRepo, D([J('J4', 'dev', 'be', 1), J('J5', 'reviewer', 'be', 2)]), pack(6), close, close])
  expect(r.out.status).toBe('escalate')
  expect(r.out.question).toContain('no tester PASS after its last dev job')
})

test('a FAIL is cleared by a PASS in a later group, not by one beside it', async () => {
  const failJ3 = (l) => (l === 'J3 tester:be' ? ok('FAIL') : std(l))
  const later = await sim([oneRepo, D([J('J4', 'tester', 'be', 1)]), pack(5), close], failJ3)
  expect(later.out.status).toBe('done')
  const beside = await sim([D([...oneRepo.jobs, J('J4', 'tester', 'be', 3)]), pack(5), close, close], failJ3)
  expect(beside.out.question).toContain('tester J3 did not PASS')
})

test('no PR counts unless its PACKAGE job started after the tester PASS', async () => {
  const r = await sim([D([J('J1', 'dev', 'be', 1), J('J2', 'reviewer', 'be', 2, 'PACKAGE')]), close, close])
  expect(r.out.status).toBe('escalate')
})

test('a tester FAIL skips the later groups: PACKAGE never pushes code that just failed', async () => {
  const pm = [D([...oneRepo.jobs, J('J4', 'reviewer', 'be', 4, 'PACKAGE')]), escalate]
  const r = await sim(pm, l => (l === 'J3 tester:be' ? ok('FAIL', { issues: ['IB1'] }) : std(l)))
  expect(r.ran.some(x => x.startsWith('J4'))).toBe(false)
  expect(r.pmPrompts[1]).toContain('its tester did not PASS')
  // the skipped id is free again, and a PASS lets the same dispatch run through
  const pass = await sim([D([...oneRepo.jobs, J('J4', 'reviewer', 'be', 4, 'PACKAGE')]), close])
  expect(pass.out.status).toBe('done')
})

test('review mode is static: a reviewer alone closes it, no tester and no app server', async () => {
  const review = await sim([D([J('J1', 'setup', 'all', 1), J('J2', 'reviewer', 'all', 2)]), close], std, { mode: 'review' })
  expect(review.out.status).toBe('reviewed')
  expect(review.ran.length).toBe(2)
  expect(review.prompts[Object.keys(review.prompts).find(k => k.startsWith('J1'))]).toContain('start NO app server')
  // e2e is its own command: a tester job is refused here
  const withTester = await sim([D([J('J1', 'tester', 'all', 1), J('J2', 'reviewer', 'all', 2)]), close, close], std, { mode: 'review' })
  expect(withTester.ran.some(x => x.includes('tester'))).toBe(false)
  expect(withTester.pmPrompts[1]).toContain('role tester is not allowed in mode review')
})

test('IMPACT lines of a gate reach the testers of the same repo later in the dispatch', async () => {
  const impact = 'IMPACT1: sports.ts:949 — basketball slots — expected: as on the base'
  const pm = [D([J('J1', 'dev', 'be', 1), J('J2', 'dev', 'fe', 1), ...gates(['be', 'fe'], 2, 3), J('J5', 'tester', 'be', 3), J('J6', 'tester', 'fe', 3)]), pack(7, ['be', 'fe']), close]
  const r = await sim(pm, l => (l === 'J3 reviewer:be' ? ok('SHIP', { issues: [impact, 'QP1 [P3]: x'] }) : std(l)))
  expect(r.out.status).toBe('done')
  expect(r.prompts['J5 tester:be']).toContain(impact)
  expect(r.prompts['J5 tester:be']).not.toContain('QP1')
  expect(r.prompts['J6 tester:fe']).not.toContain('Impact cases')
})

test('an unclear brief goes back to the user before anything runs', async () => {
  const ask = { decision: 'clarify', size: 'S', note: 'two readings', questions: [{ id: 'Q1', question: 'Which icon?', quote: '"icon lệch"', options: ['glyph inside the circle', 'icon vs label'], assume: 'glyph' }] }
  const first = await sim([ask])
  expect(first.out.status).toBe('clarify')
  expect(first.out.questions[0].id).toBe('Q1')
  expect(first.out.clarifyRound).toBe(1)
  expect(first.ran).toEqual([])
  expect(first.pmPrompts[0]).toContain('Understand before you plan')
  // answered: the PM is told not to ask again, and a clear task runs straight through
  const answered = await sim([D(withCases, 'S'), D([J('J4', 'reviewer', 'be', 1, 'PACKAGE')], 'S'), close], std, { clarifyRound: 1 })
  expect(answered.out.status).toBe('done')
  expect(answered.pmPrompts[0]).toContain('never ask those again')
  // not mid-run, not with --assume, not a fourth time
  const mid = await sim([D(withCases, 'S'), ask, ask])
  expect(mid.out.question).toContain('only for the first decision of a run')
  expect((await sim([ask, ask], std, { flags: { assume: true } })).out.question).toContain('--assume')
  expect((await sim([ask, ask], std, { clarifyRound: 3 })).out.question).toContain('already answered questions 3 times')
})

test('small-task lane: dev → tester → PACKAGE in one dispatch, the PACKAGE job gates first', async () => {
  const lane = (size, extra = []) => D([J('J1', 'dev', 'be', 1, 'x', 'opus'), ...extra, J('J2', 'tester', 'be', 2, 'x', 'sonnet', 'C1'), J('J3', 'reviewer', 'be', 3, 'PACKAGE', 'haiku')], size)
  const files = (n) => (l) => (l.includes('lead') ? { ...solo, filesChanged: Array.from({ length: n }, (_, i) => `f${i}.ts`) } : std(l))
  const r = await sim([lane('S'), close], files(2))
  expect(r.out.status).toBe('done')
  expect(r.ran).toEqual(['J1 lead:be(opus)', 'J2 tester:be(sonnet)', 'J3 reviewer:be(opus)']) // 3 jobs, gate on the lead's model
  expect(r.prompts['J3 reviewer:be']).toContain('NO GATE RAN on this code')
  expect(r.prompts['J1 lead:be']).not.toContain('XS task')
  // with a gate in the dispatch the PACKAGE job is an ordinary one
  const gatedRun = await sim([D(withCases, 'S'), D([J('J4', 'reviewer', 'be', 1, 'PACKAGE')], 'S'), close])
  expect(gatedRun.prompts['J4 reviewer:be']).not.toContain('NO GATE RAN')
  // M/L: the gate comes first
  expect((await sim([lane('M'), lane('M')])).out.question).toContain('has no reviewer gate SHIP')
  // a dev job that grew past 3 files stops the dispatch for a gate
  const big = await sim([lane('S'), escalate], files(4))
  expect(big.ran).toEqual(['J1 lead:be(opus)'])
  expect(big.pmPrompts[1]).toContain('be changed 4')
  // a PACKAGE that found a problem at its gate is not a PR: close is refused
  const bad = await sim([lane('S'), close, close], (l) => (l.includes('reviewer') ? ok('NEEDS-WORK', { issues: ['QP1 [P2]: x'] }) : files(1)(l)))
  expect(bad.out.question).toContain('no reviewer PACKAGE job (SHIP + PR URL)')
})

test('XS is one repo with no FLOWS job; no FLOWS job in a fix round', async () => {
  const xs = (jobs) => D(jobs, 'XS')
  const twoRepos = xs([J('J1', 'dev', 'be', 1), J('J2', 'dev', 'fe', 1)])
  expect((await sim([twoRepos, twoRepos])).out.question).toContain('an XS task changes one repo')
  const withFlows = xs([J('J1', 'dev', 'be', 1), J('J2', 'tester', 'be', 1, 'FLOWS')])
  expect((await sim([withFlows, withFlows])).out.question).toContain('no FLOWS job on an XS task')
  const one = await sim([xs([J('J1', 'dev', 'be', 1), J('J2', 'tester', 'be', 2, 'x', 'sonnet', 'C1'), J('J3', 'reviewer', 'be', 3, 'PACKAGE')]), close])
  expect(one.out.status).toBe('done')
  expect(one.prompts['J1 lead:be']).toContain('XS task: do it yourself')
  const fix = D([J('J4', 'dev', 'be', 1), J('J5', 'tester', 'be', 1, 'FLOWS')])
  expect((await sim([oneRepo, fix, fix])).out.question).toContain('no FLOWS job in a fix round')
  // a new repo joining in a later dispatch may still get its flows written
  const newRepo = D([J('J4', 'dev', 'fe', 1), J('J5', 'tester', 'fe', 1, 'FLOWS'), J('J6', 'reviewer', 'fe', 2), J('J7', 'tester', 'fe', 3)])
  expect((await sim([oneRepo, newRepo, pack(8, ['be', 'fe']), close])).out.status).toBe('done')
})

test('a job that cannot finish twice in a row stops the run instead of being sent again', async () => {
  const blockedPack = (l) => (l.includes('reviewer') && l !== 'J2 reviewer:be' ? { status: 'blocked', verdict: 'NONE', summary: 'Bash refused by the auto-mode classifier', blocked: ['git push'] } : std(l))
  const pm = [oneRepo, pack(4), pack(5), { ...escalate, escalate: 'allow git push for this session' }, pack(6)]
  const r = await sim(pm, blockedPack)
  expect(r.out.status).toBe('escalate')
  expect(r.out.question).toContain('reviewer PACKAGE on be could not finish twice in a row (J4, J5)')
  expect(r.out.question).toContain('tool-permission block')
  expect(r.out.question).toContain('PM: allow git push for this session')
  expect(r.ran.some(x => x.startsWith('J6'))).toBe(false)
  expect(r.pmPrompts[3]).toContain('STUCK')
  // one block followed by a finished job of the same kind is not stuck
  let n = 0
  const once = await sim([oneRepo, pack(4), pack(5), close], (l) => (l.includes('reviewer') && l !== 'J2 reviewer:be' && n++ === 0 ? { status: 'blocked', verdict: 'NONE', summary: 'port busy' } : std(l)))
  expect(once.out.status).toBe('done')
  // a blocked gate and a blocked PACKAGE are different jobs
  const mixed = await sim([oneRepo, pack(4), escalate], (l) => (l.includes('reviewer') ? { status: 'blocked', verdict: 'NONE', summary: 'x' } : std(l)))
  expect(mixed.out.question).toBe('stop')
})

test('size L: the design and the plan go to the user before the first job', async () => {
  const big = D(oneRepo.jobs, 'L')
  const r = await sim([big])
  expect(r.out.status).toBe('approve')
  expect(r.out.design).toBe('/r/.pipeline/T-1/design.md')
  expect(r.ran).toEqual(['J0 reviewer:plan(opus)'])
  expect(r.prompts['J0 reviewer:plan']).toContain('/r/.pipeline/T-1/design.md')
  expect(r.pmPrompts[0]).toContain('write design.md before plan.md')
  // approved, or --assume: it runs; and the lead is asked for its approach
  const ok1 = await sim([big, pack(4), close], std, { approved: true })
  expect(ok1.out.status).toBe('done')
  expect(ok1.prompts['J1 lead:be']).toContain('## Approach')
  expect((await sim([big, pack(4), close], std, { flags: { assume: true } })).out.status).toBe('done')
  // M does not stop, and its plan check is not pointed at a design file
  const m = await sim([oneRepo, pack(4), close])
  expect(m.out.status).toBe('done')
  expect(m.prompts['J0 reviewer:plan']).not.toContain('design.md')
  expect(m.prompts['J1 lead:be']).not.toContain('## Approach')
  // a plan-check point is settled first, then the user still sees the design
  const pts = await sim([big, { ...big, planKept: [] }], l => (l === 'J0 reviewer:plan' ? ok('NEEDS-WORK', { issues: ['PP1: "x" — y'] }) : std(l)))
  expect(pts.out.status).toBe('approve')
  expect(pts.out.design).toBe('/r/.pipeline/T-1/design.md')
})

test('plan check: points go back to the PM once and the first dispatch is not run', async () => {
  const r = await sim([oneRepo, D([J('J1', 'dev', 'be', 1)]), escalate], l => (l === 'J0 reviewer:plan' ? ok('NEEDS-WORK', { issues: ['PP1: "also on the web admin" — no fe section'] }) : std(l)))
  expect(r.ran).toEqual(['J0 reviewer:plan(opus)', 'J1 lead:be(sonnet)'])
  expect(r.pmPrompts[0]).toContain('Hard rules the executor enforces')
  expect(r.pmPrompts[1]).toContain('PP1: "also on the web admin"')
  expect(r.pmPrompts[2]).not.toContain('Plan check')
})

test('plan check runs for M/L only, and before the user is asked to approve', async () => {
  const small = await sim([D(withCases, 'S'), D([J('J4', 'reviewer', 'be', 1, 'PACKAGE')], 'S'), close])
  expect(small.ran.some(x => x.startsWith('J0'))).toBe(false)
  const approve = await sim([{ decision: 'approve', size: 'L', note: 'plan ready', scope: 'be only' }], std, { flags: { approve: true } })
  expect(approve.out.status).toBe('approve')
  expect(approve.ran).toEqual(['J0 reviewer:plan(opus)'])
})

test('the user is asked only when the PM keeps the plan against a plan-check point', async () => {
  const points = (l) => (l === 'J0 reviewer:plan' ? ok('NEEDS-WORK', { issues: ['PP1: "also on the web admin" — no fe section'] }) : std(l))
  const kept = await sim([oneRepo, { ...oneRepo, planKept: ['PP1 — "admin" is the mobile admin role (comment 3)'] }], points)
  expect(kept.out.status).toBe('approve')
  expect(kept.out.planOpen).toEqual(['PP1 — "admin" is the mobile admin role (comment 3)'])
  expect(kept.ran).toEqual(['J0 reviewer:plan(opus)'])
  const taken = await sim([oneRepo, { ...oneRepo, planKept: [] }, pack(4), close], points)
  expect(taken.out.status).toBe('done')
})

test('a small task runs only the cases its change touches', async () => {
  const noCases = await sim([D(oneRepo.jobs, 'S'), D(oneRepo.jobs, 'S')])
  expect(noCases.out.question).toContain('needs "cases"')
  const r = await sim([D(withCases, 'XS'), D([J('J4', 'reviewer', 'be', 1, 'PACKAGE')], 'XS'), close])
  expect(r.out.status).toBe('done')
  expect(r.prompts['J3 tester:be']).toContain('Cases: C2, C5 — run ONLY these (flow-run.mjs --cases C2,C5)')
  expect((await sim([oneRepo, pack(4), close])).prompts['J3 tester:be']).not.toContain('run ONLY these')
})

test('job limits: 12 per dispatch, 6 per group', async () => {
  const nine = D([J('J1', 'setup', 'all', 1), J('J2', 'dev', 'be', 2), J('J3', 'dev', 'mobile', 2), J('J4', 'tester', 'all', 2, 'FLOWS a'), J('J5', 'tester', 'all', 2, 'FLOWS b'), ...gates(['be', 'mobile'], 3, 6), J('J8', 'tester', 'be', 4), J('J9', 'tester', 'mobile', 4)])
  expect((await sim([nine, pack(10, ['be', 'mobile']), close])).out.status).toBe('done')
  const seven = D([1, 2, 3, 4, 5, 6, 7].map(n => J(`J${n}`, 'tester', 'all', 1, 'x', 'sonnet', 'C1')))
  expect((await sim([seven, seven], std, { mode: 'e2e', snapshot: '/r/.pipeline/T-1/cases.approved.json', runScope: ['C1'] })).out.question).toContain('at most 6 run at the same time')
})

test('writer and judge never share a group; one dev job per repo', async () => {
  const mixed = D([J('J1', 'dev', 'be', 1), J('J2', 'tester', 'be', 1)])
  expect((await sim([mixed, mixed])).out.question).toContain('same group as a dev job')
  const two = D([J('J1', 'dev', 'be', 1), J('J2', 'dev', 'be', 1)])
  expect((await sim([two, two])).out.question).toContain('ONE dev job per repo')
})

const team = { split: true, summary: 'two parts', interfaces: 'svc.importUnits(dto): Result', headBefore: 'aaaaaaa1', members: [{ title: 'service', tasks: 'M1', files: ['src/s.ts'] }, { title: 'api', tasks: 'M2', files: ['./src/c.ts'], model: 'opus' }] }
test('a lead team runs its members in one worktree with separate files, then merges', async () => {
  const r = await sim([oneRepo, pack(4), close], l => (l === 'J1 lead:be' ? team : l === 'J1 lead:be merge' ? { ...ok('NONE'), headAfter: 'aaaaaaa1' } : std(l)))
  expect(r.out.status).toBe('done')
  expect(r.ran).toContain('J1b dev:be(opus)')
  expect(r.prompts['J1b dev:be']).toContain('Your files (edit nothing else): ./src/c.ts')
  expect(r.prompts['J1b dev:be']).toContain('Their files (do not touch): src/s.ts')
  const overlap = { ...team, members: [team.members[0], { title: 'x', tasks: 'M2', files: ['src/s.ts'] }] }
  const bad = await sim([oneRepo, escalate], l => (l === 'J1 lead:be' ? overlap : std(l)))
  expect(bad.logs.join('\n')).toContain('belongs to both member 1 and member 2')
  expect(bad.ran.some(x => x.includes('reviewer:be'))).toBe(false)
})

test('a dev job that committed has its commits undone before anyone judges it', async () => {
  const committed = { ...solo, headAfter: 'bbbbbbb2' }
  const undone = await sim([oneRepo, pack(4), close], l => (l === 'J1 lead:be' ? committed : l.endsWith('uncommit') ? ok('NONE', { summary: 'undone 1' }) : std(l)))
  expect(undone.ran).toContain('J1 lead:be uncommit(haiku)')
  expect(undone.prompts['J1 lead:be uncommit']).toContain('task.mjs uncommit /wt/be aaaaaaa1')
  expect(undone.out.status).toBe('done')
  const stuck = await sim([oneRepo, escalate], l => (l === 'J1 lead:be' ? committed : l.endsWith('uncommit') ? { status: 'blocked', verdict: 'NONE', summary: 'refused: already pushed' } : std(l)))
  expect(stuck.ran.some(x => x.includes('reviewer:be'))).toBe(false)
  expect(stuck.pmPrompts[1]).toContain('could not be undone')
})

test('several testers in one group: own scratch folders, one writer of the flow library', async () => {
  const r = await sim([D([J('J1', 'dev', 'be', 1), J('J2', 'reviewer', 'be', 2), J('J3', 'tester', 'be', 3), J('J4', 'tester', 'be', 3)]), pack(5), close])
  expect(r.prompts['J3 tester:be']).toContain('/r/.pipeline/T-1/tmp/J3/')
  expect(r.prompts['J3 tester:be']).toContain('you are the only job in this group that may edit /r/.pipeline/_lib')
  expect(r.prompts['J4 tester:be']).toContain('FLOW LIBRARY READ-ONLY: J3')
  const single = await sim([oneRepo, pack(4), close])
  expect(single.prompts['J3 tester:be']).not.toContain('FLOW LIBRARY')
})

test('the documented limits are the ones the executor enforces', () => {
  const num = (name) => Number(src.match(new RegExp(`const ${name} = (\\d+)`))[1])
  const design = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'design.md'), 'utf8')
  const line = `${num('MAX_TURNS')} PM turns · ${num('MAX_JOBS')} jobs per dispatch · ${num('MAX_GROUP')} jobs per group · ${num('MAX_DEV_PER_REPO')} dev jobs per repo per run · ${num('MAX_MEMBERS')} members per lead`
  expect(design).toContain(line)
})

test('every plugin file a document points at exists', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const docs = ['README.md', 'docs/design.md', 'docs/orchestrator.md', 'docs/pm-feedback.md', 'hosts/claude/docs/attach.md', 'docs/config-template.md', 'agents/pm.md', 'agents/lead.md', 'agents/dev.md', 'agents/tester.md', 'agents/reviewer.md']
  const missing = []
  for (const d of docs) {
    const text = readFileSync(join(root, d), 'utf8')
    for (const m of text.matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}\/|<PLUGIN>\/|<plugin>\/|\]\()((?:docs|agents|guidelines|scripts|hooks|engine|tests|skills)\/[\w./-]+\.(?:md|mjs|js|ts|tsx|sh))/g)) {
      if (!existsSync(join(root, m[1]))) missing.push(`${d} → ${m[1]}`)
    }
    // bare mentions like `guidelines/e2e-testing.md` or `scripts/platform.mjs`
    for (const m of text.matchAll(/`((?:docs|agents|guidelines|scripts|hooks|engine|tests)\/[\w.-]+\.(?:md|mjs|js|ts|tsx|sh))`/g)) {
      if (!existsSync(join(root, m[1]))) missing.push(`${d} → ${m[1]}`)
    }
  }
  expect(missing).toEqual([])
})

test('build and qc never run a PACKAGE job on code no tester passed, whatever the size', async () => {
  const r = await sim([D([J('J1', 'dev', 'be', 1), J('J2', 'reviewer', 'be', 2, 'PACKAGE')], 'S'), escalate])
  expect(r.ran.some(x => x.startsWith('J2'))).toBe(false)
  expect(r.pmPrompts[1]).toContain('would push code no tester has passed')
  // The same PACKAGE job is accepted once a tester for that repo sits between the dev job and it.
  const fine = await sim([D([J('J1', 'dev', 'be', 1), J('J2', 'tester', 'be', 2, 'x', 'sonnet', 'C1'), J('J3', 'reviewer', 'be', 3, 'PACKAGE')], 'S'), close])
  expect(fine.ran.some(x => x.startsWith('J3'))).toBe(true)
})

// ── e2e: approved test cases ────────────────────────────────────────────────
const SNAP = { mode: 'e2e', snapshot: '/r/.pipeline/T-1/cases.approved.json', runScope: ['TC1', 'TC2'] }
const casesD = (extra = {}) => ({ decision: 'cases', size: 'M', note: 'n', caseIds: ['TC1', 'TC2'], target: 'local', ...extra })
const testerOk = (lines) => (label) => (label.includes('tester') ? ok('PASS', { cases: lines }) : ok('NONE'))

test('e2e without approved cases stops at status cases, before any job', async () => {
  const r = await sim([casesD({ questions: [{ id: 'Q1', question: 'q?', quote: 'x', options: ['a', 'b'], assume: 'a', who: 'user', cases: ['TC2'] }], missingSpecs: ['screen X'] })], std, { mode: 'e2e' })
  expect(r.out.status).toBe('cases')
  expect(r.out.caseIds).toEqual(['TC1', 'TC2'])
  expect(r.out.clarifyRound).toBe(1)
  expect(r.out.missingSpecs).toEqual(['screen X'])
  expect(r.ran).toEqual([])
  expect(r.pmPrompts[0]).toContain('E2E test cases first')
})

test('e2e gate holds on every turn: a dispatch or a clarify without approved cases is rejected', async () => {
  const r = await sim([D([J('J1', 'tester', 'all', 1, 'x', 'sonnet', 'TC1')]), casesD()], std, { mode: 'e2e' })
  expect(r.out.status).toBe('cases')
  expect(r.ran).toEqual([])
  expect(r.pmPrompts[1]).toContain('e2e runs only approved test cases')
  const c = await sim([{ decision: 'clarify', size: 'M', note: 'n', questions: [{ id: 'Q1', question: 'q', quote: 'x', options: ['a'], assume: 'a' }] }, casesD()], std, { mode: 'e2e' })
  expect(c.out.status).toBe('cases')
  expect(c.pmPrompts[1]).toContain('the questions go with the cases')
})

test('e2e cases: --assume allows no questions; caseIds are required', async () => {
  const q = [{ id: 'Q1', question: 'q', quote: 'x', options: ['a'], assume: 'a' }]
  const r = await sim([casesD({ questions: q }), casesD()], std, { mode: 'e2e', flags: { assume: true } })
  expect(r.out.status).toBe('cases')
  expect(r.out.assume).toBe(true)
  expect(r.pmPrompts[1]).toContain('--assume')
  const n = await sim([casesD({ caseIds: [] }), casesD()], std, { mode: 'e2e' })
  expect(n.pmPrompts[1]).toContain('needs caseIds')
})

test('e2e: approved without a snapshot, or a snapshot without a run scope, is an error', async () => {
  expect((await sim([], std, { mode: 'e2e', approved: true })).out.status).toBe('error')
  expect((await sim([], std, { mode: 'e2e', snapshot: '/x.json' })).out.status).toBe('error')
})

test('e2e with a snapshot: PM on sonnet, testers only inside the run scope, read the snapshot', async () => {
  const outside = D([J('J1', 'tester', 'all', 1, 'x', 'sonnet', 'TC1, TC9')])
  const good = D([J('J2', 'tester', 'all', 1, 'x', 'sonnet', 'TC1, TC2')])
  const r = await sim([outside, good, close], testerOk(['TC1 | PASS', 'TC2 | Failed — BUG: x']), SNAP)
  expect(r.out.status).toBe('verified')
  expect(r.pmPrompts[1]).toContain('outside this run')
  expect(r.ran).toEqual(['J2 tester:all(sonnet)'])
  expect(r.prompts['J2 tester:all']).toContain('read each case from /r/.pipeline/T-1/cases.approved.json')
  expect(r.prompts['J2 tester:all']).toContain('--mark-written')
  expect(r.pmPrompts[0]).toContain('Do NOT analyse the task again')
  const none = await sim([D([J('J1', 'tester', 'all', 1)]), good, close], testerOk(['TC1 | PASS', 'TC2 | PASS']), SNAP)
  expect(none.pmPrompts[1]).toContain('needs "cases"')
})

test('e2e close needs a result for every case in the run scope; FLOWS jobs do not count, blocked does', async () => {
  const one = D([J('J1', 'tester', 'all', 1, 'x', 'sonnet', 'TC1, TC2')])
  const partial = await sim([one, close, escalate], testerOk(['TC1 | PASS']), SNAP)
  expect(partial.pmPrompts[2]).toContain('no tester result for TC2')
  const flowsOnly = await sim([D([J('J1', 'tester', 'all', 1, 'FLOWS write', 'sonnet', 'TC1, TC2')]), close, escalate],
    (label) => ok('NONE', { cases: ['TC1 | PASS', 'TC2 | PASS'] }), SNAP)
  expect(flowsOnly.pmPrompts[2]).toContain('no tester result for TC1, TC2')
  const blocked = await sim([one, close], (label) => ({ status: 'blocked', verdict: 'FAIL', summary: 's', cases: ['TC1 | PASS', 'TC2 | Not tested — no emulator'] }), SNAP)
  expect(blocked.out.status).toBe('verified')
})

test('decision=cases outside e2e, or after approval, is rejected', async () => {
  const b = await sim([casesD(), escalate])
  expect(b.pmPrompts[1]).toContain('decision=cases is for e2e only')
  const a = await sim([casesD(), escalate], std, SNAP)
  expect(a.pmPrompts[1]).toContain('already approved')
})

test('models: PM on sonnet for turns that only dispatch after green reports, opus when it must judge', async () => {
  const flow = [D([J('J1', 'dev', 'be', 1), J('J2', 'reviewer', 'be', 2)]), D([J('J3', 'tester', 'be', 1)]), D([J('J4', 'reviewer', 'be', 1, 'PACKAGE')]), close]
  const green = await sim(flow)
  expect(green.pmModels).toEqual(['opus', 'sonnet', 'sonnet', 'sonnet']) // M task: was opus on every turn
  const failing = await sim(flow, (label) => (label.includes('tester') ? ok('FAIL', { issues: ['IB1'] }) : std(label)))
  expect(failing.pmModels[2]).toBe('opus') // the turn that reads the FAIL
})

test('models: setup runs on haiku unless the PM says why; PACKAGE never below sonnet', async () => {
  const setup = (why) => ({ ...J('J1', 'setup', 'all', 1, 'x', 'sonnet'), ...(why ? { modelWhy: why } : {}) })
  let r = await sim([D([setup(''), J('J2', 'dev', 'be', 2, 'x', 'haiku'), J('J3', 'reviewer', 'be', 3), J('J4', 'tester', 'be', 4), J('J5', 'reviewer', 'be', 5, 'PACKAGE', 'haiku')]), close])
  expect(r.ran).toContain('J1 setup:all(haiku)')
  expect(r.ran).toContain('J5 reviewer:be(sonnet)')
  r = await sim([D([setup('chain node build needs judgement')]), close])
  expect(r.ran).toContain('J1 setup:all(sonnet)')
})

test('models: a haiku job that does not finish is tried once more on sonnet', async () => {
  const r = await sim([D([J('J1', 'setup', 'all', 1)], 'S'), close], (label, prompt) =>
    label.startsWith('J1') && !/smaller model stopped/.test(prompt) ? { status: 'blocked', verdict: 'NONE', summary: 'port busy' } : std(label))
  expect(r.ran).toEqual(['J1 setup:all(haiku)', 'J1 setup:all(sonnet)'])
  expect(r.logs.join('\n')).toContain('model haiku → sonnet')
})

test('jobs are pointed at the config sections of their role; e2e PM turns at docs/pm-e2e.md', async () => {
  const r = await sim([D([J('J1', 'setup', 'all', 1), J('J2', 'dev', 'be', 2), J('J3', 'tester', 'be', 3, 'x', 'sonnet', 'C1')], 'S'), close])
  expect(r.prompts['J1 setup:all']).toContain('task.mjs config /r --role setup')
  expect(r.prompts['J2 lead:be']).toContain('task.mjs config /r --role dev')
  expect(r.prompts['J3 tester:be']).toContain('task.mjs config /r --role tester')
  const e = await sim([{ decision: 'cases', size: 'S', note: 'n', caseIds: ['TC1'], questions: [], missingSpecs: [], target: 'local' }], std, { mode: 'e2e' })
  expect(e.pmPrompts[0]).toContain('/s/../docs/pm-e2e.md')
})
