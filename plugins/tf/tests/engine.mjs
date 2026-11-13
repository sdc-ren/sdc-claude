// The executor's hard rules, run against mock agents: no model, no git, no files. Each scenario scripts the
// PM's decisions and what every job answers, then checks how the run ended and which jobs ran.
import { readFileSync } from 'node:fs'
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

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'task-flow.js'), 'utf8').replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor



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
  const agent = async (prompt, o) => {
    if (/^PM t/.test(o.label)) { pmPrompts.push(prompt); return pm[turn++] }
    ran.push(`${o.label}(${o.model})`)
    prompts[o.label] = prompt
    return answer(o.label, prompt)
  }
  const args = { root: '/r', slug: 'T-1', dir: '/r/.pipeline/T-1', scripts: '/s', config: '/c', mode: 'build', worktreePaths: { be: '/wt/be', fe: '/wt/fe', mobile: '/wt/mobile' }, ...extra }
  const parallel = (fns) => Promise.all(fns.map(f => f()))
  const budget = { total: 0, remaining: () => 1e9, spent: () => 0 }
  const out = await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', 'budget', src)(args, agent, parallel, () => {}, (m) => logs.push(m), budget)
  return { out, ran, logs, prompts, pmPrompts }
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
  const seven = D([1, 2, 3, 4, 5, 6, 7].map(n => J(`J${n}`, 'tester', 'all', 1)))
  expect((await sim([seven, seven], std, { mode: 'e2e' })).out.question).toContain('at most 6 run at the same time')
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
