// SDC tf plugin — task-flow PM-led executor. Launched by the /tf:build|qc|feedback|review|e2e skills (docs/orchestrator.md); design in docs/design.md.
//
// The PM (tf:pm) decides every step: it reads the task, writes the plan, returns a dispatch (jobs, roles,
// models, parallel groups). This script runs the jobs, enforces the hard rules, hands the reports back to
// the PM, and repeats until the PM closes or escalates. No filesystem here: agents write their own files,
// the orchestrator handles lock/unlock and close-out around the run.
//
// args: { root, slug, dir, mode: 'build'|'qc'|'feedback'|'review'|'e2e', round, input, description?, sources?, tracker?, cases?, notes?,
//         prs?: {repo: url}, worktrees?: {repo: path|null}, worktreePaths?: {repo: path}, format?: 'new'|'old'|'current',
//         flags?: { approve?: bool, draft?: bool, check?: bool (feedback: triage only), assume?: bool (never ask, assume; no design approval on L) }, approved?: bool, clarifyRound?: n (times the user already answered questions), lang?, writingLang?, scripts, config }
//         e2e only: snapshot?: <task>/cases.approved.json (the test cases the user approved — verified by the orchestrator with cases.mjs),
//         runScope?: [internal case ids this run must give a result for], editRound?: n (times the user edited the cases)
// returns { status: 'done'|'triaged'|'verified'|'reviewed'|'escalate'|'approve'|'clarify'|'cases'|'handoff'|'error', … }
// e2e without a snapshot always stops at 'cases' (cases.md written, nothing run): the user edits and approves the
// test cases, the orchestrator freezes them (cases.mjs approve) and relaunches with snapshot + runScope.

export const meta = {
  name: 'task-flow',
  description: 'PM-led task pipeline: PM plans and dispatches dev/tester/reviewer jobs until the task closes',
  whenToUse: 'Internal engine of /tf:build, /tf:qc, /tf:address-review, /tf:review, /tf:e2e — launched by those skills with args; do not run it directly.',
  phases: [
    { title: 'PM', detail: 'tf:pm reads the task, plans (the plan is checked once by tf:reviewer on M/L tasks), dispatches, reviews reports, closes' },
    { title: 'Jobs', detail: 'setup / dev (lead + members) / tester / reviewer jobs from the PM dispatch, parallel per group' },
  ],
}

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_TURNS = 12
const MAX_JOBS = 12 // jobs in one dispatch, all groups together
const MAX_GROUP = 6 // jobs in one group, i.e. running at the same time
const MAX_MEMBERS = 3 // dev members a repo's lead may run at once (one worktree, disjoint files)
const MAX_DEV_PER_REPO = 6 // dev jobs per repo per run: the build plus the fix loop
const FAST_FILES = 3 // small-task lane: a dev job that changed more files than this gets a gate before the tester
const MAX_CLARIFY = 3 // times a task may go back to the user with questions before any job runs
const RESERVE = 80_000

const ROLES = {
  build: ['setup', 'dev', 'tester', 'reviewer'],
  qc: ['setup', 'dev', 'tester', 'reviewer'],
  feedback: ['setup', 'dev', 'tester', 'reviewer'],
  review: ['setup', 'reviewer'], // static: reading the code. Running the app is /tf:e2e, asked for on its own.
  e2e: ['setup', 'tester'],
}
const DONE_STATUS = { build: 'done', qc: 'done', feedback: 'done', review: 'reviewed', e2e: 'verified' }
const CODE_MODES = ['build', 'qc', 'feedback']
const MODELS = ['haiku', 'sonnet', 'opus']

// ── Schemas ──────────────────────────────────────────────────────────────────
const DISPATCH = {
  type: 'object',
  required: ['decision', 'size', 'note'],
  properties: {
    decision: { type: 'string', enum: ['dispatch', 'close', 'escalate', 'approve', 'clarify', 'cases'] },
    caseIds: { type: 'array', items: { type: 'string' }, description: 'decision=cases (e2e only): the internal ids of the cases you wrote to cases.md, in order.' },
    missingSpecs: { type: 'array', items: { type: 'string' }, description: 'decision=cases: one line per screen or flow with no spec to take the expected result from — what is missing and how to add it.' },
    target: { type: 'string', description: 'decision=cases: the target you propose (local, dev, …), as written in cases.md.' },
    questions: {
      type: 'array',
      description: 'decision=clarify (first decision of a run only, before plan.md): what the brief leaves open and an answer would change what gets built. In e2e the questions go with decision=cases instead, each naming the cases it affects.',
      items: {
        type: 'object',
        required: ['id', 'question', 'quote', 'options', 'assume'],
        properties: {
          id: { type: 'string', description: 'Q<n>' },
          question: { type: 'string', description: 'One question, answerable by picking an option.' },
          quote: { type: 'string', description: 'The words of the brief that are unclear, or "(not said)" with what is missing.' },
          options: { type: 'array', items: { type: 'string' }, description: '2–4 readings, each with what it would make you build.' },
          assume: { type: 'string', description: 'The option you would take if nobody answers, and why.' },
          who: { type: 'string', enum: ['user', 'po'], description: 'po: a product decision the ticket owner must make; user: the person running the command can say.' },
          cases: { type: 'array', items: { type: 'string' }, description: 'e2e: the case ids whose expected result depends on the answer.' },
        },
      },
    },
    size: { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    note: { type: 'string', description: 'One or two lines: what this turn decided and why.' },
    planKept: { type: 'array', items: { type: 'string' }, description: 'The turn after a plan check: one line per point where you did NOT change the plan — "PP<n> — why the plan stands". Empty when you took every point.' },
    scope: { type: 'string', description: 'With the first dispatch/approve of a build or qc run, at most 5 lines for the user: repos changed, repos NOT changed and why, number of cases, the assumptions that could be wrong.' },
    escalate: { type: 'string', description: 'decision=escalate: the one question for the user, with the options.' },
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'role', 'repo', 'model', 'group', 'brief', 'doneWhen'],
        properties: {
          id: { type: 'string', description: 'J<n>, continuing the numbering in board.md' },
          role: { type: 'string', enum: ['setup', 'dev', 'tester', 'reviewer'] },
          repo: { type: 'string', description: 'config repo key, or "all" for setup/tester across repos' },
          model: { type: 'string', enum: MODELS },
          effort: { type: 'string', enum: ['low', 'medium', 'high'] },
          group: { type: 'integer', minimum: 1, description: 'same group runs in parallel; groups run in order' },
          brief: { type: 'string', description: 'What to do, concretely. Point at plan.md sections instead of repeating them.' },
          reads: { type: 'array', items: { type: 'string' }, description: 'Files/sections the job must read (keep it short).' },
          doneWhen: { type: 'string' },
          cases: { type: 'string', description: 'tester jobs: the case ids to run, comma-separated. Required on XS/S tasks: only the cases whose behaviour this change touches.' },
        },
      },
    },
    close: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        noChange: { type: 'string', description: 'build/qc/feedback: why no code change is needed (no dev job this run). feedback: every point is answered/discuss/out-of-scope.' },
        noTest: { type: 'string', description: 'feedback only: why the fix needs no e2e re-run (style, naming, comments, dead code — no behaviour change). The PACKAGE reviewer must still start after the last dev job.' },
        prs: { type: 'array', items: { type: 'object', properties: { repo: { type: 'string' }, url: { type: 'string' } } } },
        assumptions: { type: 'array', items: { type: 'string' } },
        findings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}
const REPORT = {
  type: 'object',
  required: ['status', 'verdict', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    verdict: { type: 'string', enum: ['NONE', 'PASS', 'FAIL', 'SHIP', 'NEEDS-WORK', 'BLOCK'], description: 'tester: PASS|FAIL · reviewer: SHIP|NEEDS-WORK|BLOCK · others: NONE' },
    summary: { type: 'string', description: 'At most 5 lines.' },
    issues: { type: 'array', items: { type: 'string' }, description: 'Stable ids: IB<n> (tester), QP<n> [P0-P2] (reviewer), IMPACT<n> (reviewer gate: a user of the changed code with no case — for the tester), RISK<n>.' },
    cases: { type: 'array', items: { type: 'string' }, description: 'tester: "case | PASS|Failed — BUG: impact|Not tested — reason | evidence files"' },
    repo: { type: 'string' },
    prUrl: { type: 'string' },
    prDraft: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'array', items: { type: 'string' } },
    reportFile: { type: 'string' },
    headBefore: { type: 'string', description: 'dev jobs: output of `task.mjs head <worktree>` before the first edit' },
    headAfter: { type: 'string', description: 'dev jobs: the same command after the last check' },
  },
}

// A dev job goes to the repo's lead. It either does the work itself (split=false, the REPORT fields are its
// report) or hands back a team (split=true) that the executor runs in parallel before the lead merges.
const LEAD = {
  type: 'object',
  required: ['split', 'summary'],
  properties: {
    split: { type: 'boolean', description: 'true: return members and write NO code yet. false: you implemented the job yourself — fill the report fields.' },
    members: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'tasks', 'files'],
        properties: {
          title: { type: 'string', description: 'Two to five words: the part this member owns.' },
          tasks: { type: 'string', description: 'The micro-tasks of plan.md this member implements (ids), plus anything the plan does not say.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Exact repo-relative files this member may create or edit. No file in two members.' },
          model: { type: 'string', enum: MODELS },
        },
      },
    },
    interfaces: { type: 'string', description: 'split=true: what the parts agree on before coding (function names and signatures, types, props, events).' },
    ...REPORT.properties,
  },
}

// ── Args ─────────────────────────────────────────────────────────────────────
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A || {}
const { root, slug, dir, scripts: S, config: cfg } = A
const mode = ROLES[A.mode] ? A.mode : 'build'
const round = Math.max(1, Number(A.round) || 1)
const flags = A.flags || {}
const clarifyRound = Math.max(0, Number(A.clarifyRound) || 0)
const editRound = Math.max(0, Number(A.editRound) || 0)
// e2e runs only an approved snapshot of the test cases; runScope = the ids this run must give a result for.
const snapshot = mode === 'e2e' && typeof A.snapshot === 'string' && A.snapshot ? A.snapshot : ''
const runScope = snapshot && Array.isArray(A.runScope) ? A.runScope.map(String).filter(Boolean) : []
const lang = A.lang || 'en'
const writingLang = A.writingLang || 'en'
const prs = A.prs || {}
const worktrees = A.worktrees || {}
if (!root || !slug || !dir || !S || !cfg) return { status: 'error', note: 'args need { root, slug, dir, scripts, config } — see the header of workflow.mjs' }
if (mode === 'e2e' && A.approved && !snapshot) return { status: 'error', note: 'e2e: approved without a snapshot — approve the cases with cases.mjs approve and pass snapshot (+ runScope)' }
if (snapshot && !runScope.length) return { status: 'error', note: 'e2e: a snapshot needs runScope (cases.mjs scope) — the ids this run must give a result for' }
const langRule = `Report language: ${lang} (all .pipeline files and free-text you return). Writing language for commits/PR/ticket comments: ${writingLang}, per ${S}/../guidelines/ (git.md, pr-description.md, pr-review.md, ticket-comment.md, e2e-testing.md).`
const budgetLow = () => budget.total && budget.remaining() < RESERVE
// Cost and timing are measured after the run from the agents' transcripts (scripts/metrics.mjs); the
// workflow budget is one shared counter, so a per-job difference is wrong as soon as two jobs run in parallel.
const run = (prompt, opts) => agent(prompt, opts)

// ── State of this run ────────────────────────────────────────────────────────
const ledger = [] // { job, report, turn, seq } — seq = index of the group the job ran in (groups run strictly in order)
const seenIds = new Set()
let seq = 0
const context =
  `Task ${slug} · mode ${mode} · round ${round}\nWorkspace root: ${root}\nTask folder: ${dir}\nWorkspace config: ${cfg}\nScripts: ${S}\n` +
  `Input: ${A.input || ''}\n` + (A.description ? `Description: ${A.description}\n` : '') +
  `Brief: ${dir}/ticket.md (the user's request and every source it points at${A.sources ? `: ${A.sources}` : ''}). ` +
  (A.tracker === false ? 'No tracker issue is a source: skip ticket-comment.md; put the QC-facing summary in HANDOFF.md.\n' : 'A tracker issue is a source: ticket-comment.md is drafted at close.\n') +
  (A.cases ? `Target cases: ${A.cases}\n` : '') + (A.notes ? `User notes: ${A.notes}\n` : '') +
  (snapshot ? `Approved test cases (frozen; the only cases of this run): ${snapshot} · run scope: ${runScope.join(', ')}\n` : '') +
  `PRs: ${JSON.stringify(prs)}\nWorktrees (existing): ${JSON.stringify(worktrees)}\nWorktree paths (one folder per task, one subfolder per repo — use exactly these): ${JSON.stringify(A.worktreePaths || {})}\n` +
  `Flags: approve=${!!flags.approve} draft=${!!flags.draft}${mode === 'feedback' ? ` check=${!!flags.check}` : ''}\n` +
  (mode === 'feedback' ? `PR feedback: ${dir}/feedback.md (fetched review threads R<n>, reviews, conversation comments) · triage: ${dir}/feedback-triage.md · reply drafts: ${dir}/feedback-replies.md\n` : '') +
  (Array.isArray(A.attachments) && A.attachments.length
    ? `Attachments (read the files; the design system binds UI work; a canvas's screens are the exact markup to build from — its summary lists them): ${A.attachments.map((x) => `${x.kind}: ${x.title} → ${x.file}`).join(' · ')}\n`
    : '') +
  langRule

const compact = (r) => ({
  id: r.job.id, role: r.job.role, repo: r.job.repo, status: r.report ? r.report.status : 'failed',
  verdict: r.report ? r.report.verdict : 'NONE', summary: r.report ? r.report.summary : 'agent returned nothing',
  issues: (r.report && r.report.issues) || [], cases: (r.report && r.report.cases) || [], prUrl: (r.report && r.report.prUrl) || '',
  prDraft: !!(r.report && r.report.prDraft), blocked: (r.report && r.report.blocked) || [], reportFile: (r.report && r.report.reportFile) || '',
})

// ── Guards ───────────────────────────────────────────────────────────────────
const isPackage = (j) => /^\s*PACKAGE\b/.test(j.brief || '')
// A tester job whose brief starts with FLOWS only writes flows (from plan.md cases + contract) while the dev
// works. It judges nothing: verdict NONE, never counts as a test, may share a group with the dev.
const isFlows = (j) => j.role === 'tester' && /^\s*FLOWS\b/.test(j.brief || '')
// A job that did not finish, or a reviewer gate asking for changes: later groups (the tester) would judge
// code that is about to change, so they are skipped and the PM re-plans. Same for a tester that did not PASS
// in a code mode: a PACKAGE job in a later group would commit and push code that just failed.
const stopsLaterGroups = (r) =>
  !isFlows(r.job) && (!r.report || r.report.status !== 'done' ||
  (r.job.role === 'reviewer' && !isPackage(r.job) && mode !== 'review' && ['NEEDS-WORK', 'BLOCK'].includes(r.report.verdict)) ||
  (r.job.role === 'tester' && CODE_MODES.includes(mode) && r.report.verdict !== 'PASS'))

// Small-task lane (XS/S): dev → tester → PACKAGE, and the PACKAGE job runs the gate checklist itself.
const hadDev = (repo) => ledger.some((x) => x.job.role === 'dev' && x.job.repo === repo)
const sameRepo = (a, b) => a === 'all' || b === 'all' || a === b
const isGate = (j) => j.role === 'reviewer' && !isPackage(j)
// Has the code PACKAGE job j would push been through a gate? True when no dev job touched it this run, when a
// gate SHIPped after the repo's last dev job, or when this dispatch runs a gate for it in an earlier group.
function gated(j, jobs) {
  const devNow = jobs.filter((x) => x.role === 'dev' && sameRepo(x.repo, j.repo))
  const devRun = ledger.filter((x) => x.job.role === 'dev' && sameRepo(x.job.repo, j.repo))
  if (!devNow.length && !devRun.length) return true
  if (jobs.some((x) => isGate(x) && sameRepo(x.repo, j.repo) && x.group < j.group && devNow.every((dv) => dv.group < x.group))) return true
  if (devNow.length) return false
  const devSeq = Math.max(...devRun.map((x) => x.seq))
  return ledger.some((x) => isGate(x.job) && sameRepo(x.job.repo, j.repo) && x.seq > devSeq && x.report && x.report.status === 'done' && x.report.verdict === 'SHIP')
}

// Has the code PACKAGE job j would push passed a test? PACKAGE commits, pushes and opens the PR, and that
// cannot be taken back, so it is decided before the job runs, not when the task closes. True when no dev job
// touched the repo this run, when this dispatch runs a tester for it between its last dev job and j (a tester
// that does not PASS skips the later groups), or when the ledger's last test of that code is a PASS.
function tested(j, jobs) {
  const covers = (repo) => sameRepo(repo, j.repo)
  const devNow = jobs.filter((x) => x.role === 'dev' && covers(x.repo))
  const devRun = ledger.filter((x) => x.job.role === 'dev' && covers(x.job.repo))
  if (!devNow.length && !devRun.length) return true
  if (jobs.some((x) => x.role === 'tester' && !isFlows(x) && covers(x.repo) && x.group < j.group && devNow.every((dv) => dv.group < x.group))) return true
  if (devNow.length) return false
  const devSeq = Math.max(...devRun.map((x) => x.seq))
  const tests = ledger.filter((x) => x.job.role === 'tester' && !isFlows(x.job) && covers(x.job.repo) && x.seq > devSeq && x.report && x.report.status === 'done')
  return tests.length > 0 && tests.reduce((a, b) => (b.seq > a.seq ? b : a)).report.verdict === 'PASS'
}

// e2e: an approved snapshot is the only thing a run tests, and every id in runScope needs a result.
const caseIdsOf = (j) => String(j.cases || '').split(',').map((x) => x.trim()).filter(Boolean)
function e2eResults() {
  const latest = new Map()
  for (const x of ledger) {
    if (x.job.role !== 'tester' || isFlows(x.job) || !x.report || !['done', 'blocked'].includes(x.report.status)) continue
    for (const line of x.report.cases || []) {
      const id = String(line).split('|')[0].trim()
      if (id) latest.set(id, { seq: x.seq, line: String(line) })
    }
  }
  return latest
}

function checkDispatch(d) {
  if (mode === 'feedback' && flags.check) return '--check is triage only: write feedback-triage.md and return close, no jobs'
  if (mode === 'e2e' && !snapshot) return 'e2e runs only approved test cases: write cases.md (pm.md "e2e: cases") and return decision=cases — no job runs before the user approves them'
  const jobs = d.jobs || []
  if (!jobs.length) return 'decision=dispatch needs at least one job'
  if (jobs.length > MAX_JOBS) return `at most ${MAX_JOBS} jobs per dispatch (got ${jobs.length}) — dispatch the first groups now, the rest next turn`
  for (const j of jobs) {
    if (!ROLES[mode].includes(j.role)) return `role ${j.role} is not allowed in mode ${mode} (allowed: ${ROLES[mode].join(', ')})`
    if (seenIds.has(j.id)) return `job id ${j.id} already used — continue the numbering`
    if (j.role === 'dev' && (!j.repo || j.repo === 'all')) return `dev job ${j.id} must name one repo`
    // Small tasks test what they change and nothing else: the PM names the cases, the tester runs only those.
    if (CODE_MODES.includes(mode) && ['XS', 'S'].includes(d.size || size) && j.role === 'tester' && !isFlows(j) && !String(j.cases || '').trim())
      return `tester job ${j.id} on a size ${d.size || size} task needs "cases": the ids of the cases this change touches — a small task runs only those, never the whole saved suite`
  }
  const ids = jobs.map((j) => j.id)
  if (new Set(ids).size !== ids.length) return 'duplicate job ids in one dispatch'
  if (snapshot) {
    for (const j of jobs.filter((x) => x.role === 'tester' && !isFlows(x))) {
      const cs = caseIdsOf(j)
      if (!cs.length) return `tester job ${j.id} needs "cases": the ids from the run scope it runs (${runScope.join(', ')})`
      const out = cs.filter((c) => !runScope.includes(c))
      if (out.length) return `tester job ${j.id} names cases outside this run's scope: ${out.join(', ')} — the run scope is ${runScope.join(', ')} (approved cases only)`
    }
  }
  if (CODE_MODES.includes(mode)) {
    const sz = d.size || size
    const devRepos = [...new Set(jobs.filter((j) => j.role === 'dev').map((j) => j.repo))]
    const flows = jobs.find(isFlows)
    if (sz === 'XS' && devRepos.length > 1) return `an XS task changes one repo (got dev jobs on ${devRepos.join(', ')}) — size it S or larger`
    if (flows && sz === 'XS') return `${flows.id}: no FLOWS job on an XS task — its tester writes the one or two flows it needs`
    if (flows && devRepos.length && devRepos.every(hadDev)) return `${flows.id}: no FLOWS job in a fix round (every dev job here is on a repo that already had one this run) — the tester edits the flows it re-runs`
    // PACKAGE after a gate. Small tasks may skip the separate gate: the PACKAGE job then gates first itself.
    for (const j of jobs.filter((x) => x.role === 'reviewer' && isPackage(x))) {
      j._noGate = false
      if (gated(j, jobs)) continue
      if (!['XS', 'S'].includes(sz)) return `${j.id} (PACKAGE ${j.repo}) has no reviewer gate SHIP after that repo's last dev job — on M/L tasks the gate runs first (dev → gate → tester → PACKAGE)`
      j._noGate = true
    }
    // PACKAGE after a tester PASS. A review-fix round may skip the test (close.noTest says why), so feedback
    // is judged at close; build and qc never push untested code.
    if (mode !== 'feedback') for (const j of jobs.filter((x) => x.role === 'reviewer' && isPackage(x)))
      if (!tested(j, jobs)) return `${j.id} (PACKAGE ${j.repo}) would push code no tester has passed — put a tester job for ${j.repo} after its last dev job and before ${j.id} (dev → tester → PACKAGE)`
  }
  for (const j of jobs.filter((x) => x.role === 'dev')) {
    const n = ledger.filter((x) => x.job.role === 'dev' && x.job.repo === j.repo).length + jobs.filter((x) => x.role === 'dev' && x.repo === j.repo).length
    if (n > MAX_DEV_PER_REPO) return `repo ${j.repo} would get its ${n}th dev job this run (cap ${MAX_DEV_PER_REPO}) — the fix loop is not converging; escalate with what keeps failing`
  }
  // Writer ≠ judge inside one group: a dev and a tester/reviewer for the same repo cannot run in parallel.
  const byGroup = {}
  for (const j of jobs) (byGroup[j.group] ||= []).push(j)
  for (const [n, g] of Object.entries(byGroup)) {
    if (g.length > MAX_GROUP) return `group ${n} has ${g.length} jobs — at most ${MAX_GROUP} run at the same time`
    const devRepos = new Set(g.filter((j) => j.role === 'dev').map((j) => j.repo))
    for (const repo of devRepos) {
      if (g.filter((j) => j.role === 'dev' && j.repo === repo).length > 1) return `repo ${repo} has several dev jobs in one group — dispatch ONE dev job per repo; its lead splits the work among members`
    }
    const judge = g.find((j) => (j.role === 'tester' || j.role === 'reviewer') && !isFlows(j) && (devRepos.has(j.repo) || (j.repo === 'all' && devRepos.size)))
    if (judge) return `${judge.id} (${judge.role}) runs in the same group as a dev job on ${judge.repo} — put judges in a later group`
    // Gate before test (build/qc): a NEEDS-WORK gate in parallel with the tester throws the test run away.
    if (CODE_MODES.includes(mode)) {
      const gate = g.find((j) => j.role === 'reviewer' && !isPackage(j))
      const tester = gate && g.find((j) => j.role === 'tester' && !isFlows(j) && (j.repo === 'all' || gate.repo === 'all' || j.repo === gate.repo))
      if (tester) return `${tester.id} (tester) runs in the same group as reviewer gate ${gate.id} — put the gate in an earlier group; the tester runs only on code that passed it`
    }
  }
  return ''
}

function checkClose(d) {
  const c = d.close || {}
  const ok = (x) => x.report && x.report.status === 'done'
  if (mode === 'e2e') {
    if (!snapshot) return 'e2e cannot close without approved cases — return decision=cases'
    const got = e2eResults()
    const missing = runScope.filter((id) => !got.has(id))
    if (missing.length) return `e2e cannot close: no tester result for ${missing.join(', ')} — every case in the run scope needs PASS, Failed or Not tested (with what is missing) from a tester that finished or was blocked`
    return ''
  }
  if (mode === 'review') return ledger.some((x) => x.job.role === 'reviewer' && ok(x)) ? '' : 'review cannot close without a finished reviewer job'
  if (mode === 'feedback' && flags.check) return ''
  const devs = ledger.filter((x) => x.job.role === 'dev')
  const covers = (x, repo) => x.job.repo === repo || x.job.repo === 'all' || x.report.repo === repo
  if (!devs.length) {
    if (mode === 'feedback') return c.noChange ? '' : 'feedback close without a dev job needs close.noChange (every point answered, discussed or out of scope)'
    if (!c.noChange) return 'build/qc close needs dev → tester PASS → reviewer package (SHIP + PR) in this run, or close.noChange with the reason no code change is needed'
    return ledger.some((x) => x.job.role === 'tester' && ok(x) && x.report.verdict === 'PASS') ? '' : 'close.noChange still needs a tester PASS in this run proving the current code already satisfies the task'
  }
  // Each repo is judged on its own history: a later dev job on another repo does not undo this repo's test.
  for (const repo of new Set(devs.map((x) => x.job.repo))) {
    const devSeq = Math.max(...devs.filter((x) => x.job.repo === repo).map((x) => x.seq))
    const after = ledger.filter((x) => x.seq > devSeq)
    const testers = after.filter((x) => x.job.role === 'tester' && !isFlows(x.job) && ok(x) && covers(x, repo))
    const failing = testers.filter((x) => x.report.verdict !== 'PASS')
    // A FAIL is cleared only by a PASS covering this repo in a later group (a flow or test-data error re-run).
    const failSeq = failing.length ? Math.max(...failing.map((x) => x.seq)) : devSeq
    const pass = testers.filter((x) => x.report.verdict === 'PASS' && x.seq > failSeq)
    if (failing.length && !pass.length) return `repo ${repo}: tester ${failing.map((x) => x.job.id).join(', ')} did not PASS on its latest code — fix or escalate`
    const skipTest = mode === 'feedback' && c.noTest && !testers.length
    if (!pass.length && !skipTest) return `repo ${repo}: no tester PASS after its last dev job — test the latest code before closing` + (mode === 'feedback' ? ' (or close.noTest when the fix changes no behaviour)' : '')
    const passSeq = pass.length ? Math.min(...pass.map((x) => x.seq)) : devSeq
    const ship = after.find((x) => x.job.role === 'reviewer' && ok(x) && x.report.verdict === 'SHIP' && x.report.prUrl && covers(x, repo) && x.seq > passSeq)
    if (!ship) return `repo ${repo}: no reviewer PACKAGE job (SHIP + PR URL) started after the tester PASS — the PR must be pushed only after the latest code passed`
    if (ship.report.prDraft && !flags.draft) return `repo ${repo}: PR ${ship.report.prUrl} is a draft — PRs must be ready (the user did not pass --draft); have the reviewer mark it ready or escalate the blocker`
  }
  return ''
}

// ── Job runner ───────────────────────────────────────────────────────────────
// Agent types: plugin agents are namespaced <plugin>:<name>; override with args.agentPrefix (e.g. 'tf-' for a non-plugin install).
const AP = typeof A.agentPrefix === 'string' ? A.agentPrefix : 'tf:'
const AGENT = { dev: `${AP}dev`, lead: `${AP}lead`, tester: `${AP}tester`, reviewer: `${AP}reviewer` }
const worktreeOf = (repo) => worktrees[repo] || (A.worktreePaths && A.worktreePaths[repo]) || '(see HANDOFF.md / setup report)'
const serversLine = `App servers: node ${S}/serve.mjs start ${root} ${slug} (reuses running ones; status/restart/run per its header) — never start or kill them by hand.\n`
const reportLine = (id, role, repo) =>
  `Write your report to ${dir}/jobs/${id}-${role}-${repo}.md (heredoc) and append one line: node ${S}/task.mjs journal ${dir} "${id} ${role} ${repo}: <one-line result>". ` +
  `Return the structured report; reportFile = that path.`
function jobPrompt(j) {
  return `Job ${j.id} · role ${j.role} · repo ${j.repo}\n${context}\n\n` +
    `Brief: ${j.brief}\nRead first: ${(j.reads || []).join(', ') || 'plan.md section for your repo'}\nDone when: ${j.doneWhen}\n` +
    (j.repo !== 'all' ? `Worktree: ${worktreeOf(j.repo)} · existing PR: ${prs[j.repo] || 'none'}\n` : '') +
    (j.role === 'setup'
      ? `You provision runtime resources for this task exactly as the workspace config "Provisioning" section says. Reuse everything the task already holds ` +
        `(node ${S}/resources.mjs list ${root}); worktrees go exactly to the paths listed above (<root>/.worktrees/<SLUG>/<repo dir>) — never another folder name. ` +
        `For dependencies try node ${S}/fastdeps.mjs first (see config). Register every resource with node ${S}/resources.mjs add (exit 3 = another task holds that id: take the next free one). ` +
        (mode === 'review' || mode === 'e2e'
          ? `Mode ${mode}: check out the code under test (the PR head, \`git fetch origin pull/<n>/head\`, or its branch) DETACHED in the task worktree — never create a branch, never commit. `
          : '') +
        (mode === 'review'
          ? `A review reads the code and runs typecheck/build only: start NO app server, NO emulator, build NO APK.\n`
          : `Start the app servers the plan needs with node ${S}/serve.mjs start ${root} ${slug} (config "## Servers"; it waits for each health check) and LEAVE THEM RUNNING — ` +
        `later jobs reuse them and the orchestrator stops them at run end. A config without "## Servers": smoke-check backend/frontend by hand, then stop what you started. ` +
        `Emulator + APK only when the plan needs the App (stop the emulator when done).\n`)
      : '') +
    (j.role === 'tester' && !isFlows(j) && String(j.cases || '').trim()
      ? `Cases: ${j.cases} — run ONLY these (flow-run.mjs --cases ${String(j.cases).replace(/\s+/g, '')}). Do not run, re-run or repair any other saved flow, and add no smoke case.\n`
      : '') +
    (j.role === 'tester' && snapshot
      ? `Approved cases: read each case from ${snapshot} (never from cases.md, which the user may still be editing). A flow is flows/<id>.mjs with the internal id; ` +
        `after you write or rewrite one, record it: node ${S}/flow-run.mjs ${dir} --mark-written <ids>. Point at every failure: expect(cond, msg, { at, label, expected, actual }) (tester.md "Evidence"). ` +
        `Report one line per case that starts with its id: "<id> | PASS" · "<id> | Failed — BUG: <impact>" · "<id> | Not tested — <what is missing>".\n`
      : '') +
    (j.role === 'tester' && !isFlows(j) && j._impact && j._impact.length
      ? `Impact cases (from the reviewer gate of this dispatch — other users of code this change touched; write and run one flow each on top of your cases, tester.md): ${j._impact.join(' · ')}\n`
      : '') +
    (j._noGate
      ? `NO GATE RAN on this code (small-task lane): run the whole gate checklist first (reviewer.md "Gate checklist"). Any P0–P2, tamper or read-only-zone edit → return NEEDS-WORK or BLOCK and make NO git write. An IMPACT you find has no tester after you: rate it P2 when that user's result can really change, else note it. Only a clean gate goes on to commit, push and the PR.\n`
      : '') +
    (isFlows(j)
      ? `FLOWS job: the code is being changed right now by the dev job(s) of this group. Write the flows only (tester.md "FLOWS briefs"); do not judge the app, return verdict NONE.\n`
      : '') +
    (j.role === 'dev' || j.role === 'tester' ? serversLine : '') +
    (j.role === 'tester'
      ? `Scratch: ${dir}/tmp/${j.id}/ is yours alone (temp files, seeds, downloads). Never delete or clean a folder, DB row or temp file this job did not create — other jobs run at the same time.\n` +
        (j._lib === 'reader'
          ? `FLOW LIBRARY READ-ONLY: ${j._libOwner} is the only job that may edit ${root}/.pipeline/_lib in this group. Import from it, never edit it. A helper you would add goes to ${dir}/flows/_new/${j.id}-<name>.mjs and under \`library:\` in your report (a later tester moves it in).\n`
          : j._lib === 'owner'
            ? `FLOW LIBRARY: you are the only job in this group that may edit ${root}/.pipeline/_lib; other testers import it while you work, so only add (tester.md rule 3).\n`
            : '')
      : '') +
    reportLine(j.id, j.role, j.repo)
}

// ── Dev team: lead → members → lead ──────────────────────────────────────────
// The lead's team must be runnable in one worktree: 2–3 members, each with its own files.
function checkTeam(members) {
  if (!Array.isArray(members) || members.length < 2) return 'split=true needs 2 or 3 members (one part is not a split — do the job yourself with split=false)'
  if (members.length > MAX_MEMBERS) return `at most ${MAX_MEMBERS} members (got ${members.length})`
  const owner = new Map()
  for (const [i, m] of members.entries()) {
    if (!Array.isArray(m.files) || !m.files.length) return `member ${i + 1} (${m.title || 'untitled'}) has no files — every member names the exact files it may edit`
    for (const f of m.files) {
      const key = String(f).replace(/^\.\//, '')
      if (owner.has(key)) return `${key} belongs to both member ${owner.get(key)} and member ${i + 1} — give it to one of them`
      owner.set(key, i + 1)
    }
  }
  return ''
}
const failed = (summary) => ({ status: 'failed', verdict: 'NONE', summary })
// Dev jobs never commit: the reviewer packages after the tester passed. The lead reports the worktree HEAD
// before and after; when it moved, the commits are turned back into uncommitted changes (nothing is lost).
const headLine = (repo) => `Never commit. Your FIRST command: node ${S}/task.mjs head ${worktreeOf(repo)} → return it as headBefore; the same command after your last check → headAfter.\n`
const sameHead = (a, b) => a.startsWith(b) || b.startsWith(a)
async function uncommitted(j, model, report) {
  const { headBefore: a, headAfter: b } = report
  if (!a || !b) { log(`${j.id} dev ${j.repo}: no HEAD reported — commit check skipped`); return report }
  if (sameHead(a, b)) return report
  log(`${j.id} dev ${j.repo}: committed (${a.slice(0, 8)} → ${b.slice(0, 8)}) — undoing the commits, the changes stay`)
  const fix = await run(
    `Job ${j.id} · role dev lead · repo ${j.repo}\n${context}\n\nUNCOMMIT: this dev job left commits in the worktree; dev jobs never commit (the reviewer packages after the tester passed). ` +
      `Run exactly: node ${S}/task.mjs uncommit ${worktreeOf(j.repo)} ${a}\nIt keeps every change as uncommitted work. Do nothing else. ` +
      `status done when it printed "undone", blocked with its message otherwise; summary = its output.`,
    { label: `${j.id} lead:${j.repo} uncommit`, phase: 'Jobs', model: 'haiku', schema: REPORT, agentType: AGENT.lead })
  if (fix && fix.status === 'done') return { ...report, headAfter: a }
  return { ...report, status: 'blocked', blocked: [...(report.blocked || []), `the dev job committed and the commits could not be undone: ${fix ? fix.summary : 'no answer'}`] }
}
async function runDev(j) {
  const model = MODELS.includes(j.model) ? j.model : 'sonnet'
  const head = `Job ${j.id} · role dev lead · repo ${j.repo}\n${context}\n\n` +
    `Brief: ${j.brief}\nRead first: ${(j.reads || []).join(', ') || 'plan.md section for your repo'}\nDone when: ${j.doneWhen}\n` +
    `Worktree: ${worktreeOf(j.repo)} · existing PR: ${prs[j.repo] || 'none'}\n` + serversLine + headLine(j.repo)
  const teamFile = `${dir}/jobs/${j.id}-team-${j.repo}.md`
  const ask = (why) => run(
    head + `You lead this repo's dev work for this job (lead.md). Decide first: do it yourself, or split it among 2–${MAX_MEMBERS} members who work in this worktree at the same time.\n` +
      `· Yourself (split=false): implement the job now as a developer. ${reportLine(j.id, 'dev', j.repo)}\n` +
      `· Team (split=true): write NO code. Write the team plan to ${teamFile} (members, their micro-tasks and files, the interfaces between them) and return members + interfaces.\n` +
      (size === 'XS' ? 'This is an XS task: do it yourself (split=false).\n' : '') +
      (size === 'L' ? `This is an L task: before the first edit write "## Approach" (5–10 lines, lead.md) at the top of your report file — also when you work alone; the gate reads it against ${dir}/design.md.\n` : '') +
      (why ? `REJECTED team: ${why}. Return a valid team, or split=false and do the job yourself.\n` : ''),
    { label: `${j.id} lead:${j.repo}`, phase: 'Jobs', model, schema: LEAD, agentType: AGENT.lead, ...(j.effort ? { effort: j.effort } : {}) })
  let plan = await ask('')
  if (!plan) return null
  const solo = (p) => uncommitted(j, model, { verdict: 'NONE', ...p, status: p.status || 'failed' })
  if (!plan.split) return solo(plan)
  const headBefore = plan.headBefore || ''
  let bad = checkTeam(plan.members)
  if (bad) {
    log(`${j.id} lead: ${bad}`)
    plan = await ask(bad)
    if (!plan) return null
    if (!plan.split) return solo(plan)
    bad = checkTeam(plan.members)
    if (bad) return failed(`dev lead returned an invalid team twice: ${bad}`)
  }
  const members = plan.members.map((m, i) => ({ ...m, id: `${j.id}${'abc'[i]}` }))
  log(`${j.id} lead:${j.repo} → ${members.map((m) => `${m.id} ${m.title}`).join(' · ')}`)
  const reports = await parallel(members.map((m) => () => run(
    `Job ${m.id} · role dev (member of ${j.id}) · repo ${j.repo}\n${context}\n\n` +
      `Your part: ${m.title}\nTasks: ${m.tasks}\nRead first: ${teamFile}, plan.md section for your repo\n` +
      `Worktree: ${worktreeOf(j.repo)}\n` +
      `SHARED WORKTREE: ${members.filter((x) => x !== m).map((x) => x.id).join(', ')} edit this repo at the same time. Your files (edit nothing else): ${m.files.join(', ')}. ` +
      `Their files (do not touch): ${members.filter((x) => x !== m).flatMap((x) => x.files).join(', ')}. Follow dev.md "Sharing the worktree".\n` +
      (plan.interfaces ? `Interfaces agreed by the lead: ${plan.interfaces}\n` : '') + serversLine + reportLine(m.id, 'dev', j.repo),
    { label: `${m.id} dev:${j.repo}`, phase: 'Jobs', model: MODELS.includes(m.model) ? m.model : 'sonnet', schema: REPORT, agentType: AGENT.dev })))
  const got = members.map((m, i) => ({ id: m.id, title: m.title, files: m.files, ...(reports[i] || failed('agent returned nothing')) }))
  const merged = await run(
    head + `MERGE (lead.md "Merge"): your members finished. Their reports:\n${JSON.stringify(got.map(({ id, title, status, summary, blocked, filesChanged, reportFile }) => ({ id, title, status, summary, blocked: blocked || [], filesChanged: filesChanged || [], reportFile: reportFile || '' })))}\n` +
      `Make the repo whole: do what members reported as blocked or left for you, fix the seams, run the formatter and the whole-repo typecheck/build, and the job's done-when checks. ` +
      `Then report for the whole job (filesChanged = every file changed by you and the members). ${reportLine(j.id, 'dev', j.repo)}`,
    { label: `${j.id} lead:${j.repo} merge`, phase: 'Jobs', model, schema: REPORT, agentType: AGENT.lead })
  if (merged) return uncommitted(j, model, { ...merged, headBefore: merged.headBefore || headBefore })
  return failed(`dev lead did not return after its members (${got.map((g) => `${g.id} ${g.status}`).join(', ')})`)
}
// The code gate runs on the model of the dev lead whose work it judges (the repo's last dev job; for repo
// "all" the strongest of them): the judge is never weaker than the writer. PACKAGE keeps the PM's model.
const modelOf = (j) => (MODELS.includes(j.model) ? j.model : 'sonnet')
function leadModel(repo) {
  const lastByRepo = new Map()
  for (const x of ledger) if (x.job.role === 'dev' && (repo === 'all' || x.job.repo === repo)) lastByRepo.set(x.job.repo, modelOf(x.job))
  const ms = [...lastByRepo.values()]
  return ms.length ? MODELS[Math.max(...ms.map((m) => MODELS.indexOf(m)))] : ''
}
async function runJob(j, turn) {
  let report
  if (j.role === 'dev') report = await runDev(j)
  else {
    let model = modelOf(j)
    if (j.role === 'reviewer' && (!isPackage(j) || j._noGate) && CODE_MODES.includes(mode)) {
      const lm = leadModel(j.repo)
      if (lm && lm !== model) { log(`${j.id} gate ${j.repo}: model ${model} → ${lm} (the dev lead's)`); model = lm }
    }
    const o = { label: `${j.id} ${j.role}:${j.repo}`, phase: 'Jobs', model, schema: REPORT }
    if (AGENT[j.role]) o.agentType = AGENT[j.role]
    if (j.effort) o.effort = j.effort
    report = await run(jobPrompt(j), o)
  }
  const rec = { job: j, report, turn, seq: j._seq }
  ledger.push(rec)
  return rec
}

// ═══ PM loop ═════════════════════════════════════════════════════════════════
let last = []
let violation = ''
let strikes = 0
// A job of the same kind on the same repo that did not finish twice in a row (blocked, failed, no answer):
// sending it a third time changes nothing — RVD-298 lost four PACKAGE jobs and seven PM turns to one
// permission block. The PM gets one turn to write the board and the handoff, then the run escalates.
let stuck = ''
const kindOf = (j) => `${j.role}:${j.repo}:${isPackage(j) ? 'package' : isFlows(j) ? 'flows' : ''}`
const unfinished = (r) => !r.report || r.report.status !== 'done'
const whyNot = (r) => (r.report ? [r.report.summary, ...(r.report.blocked || [])].filter(Boolean).join(' · ') : 'the agent returned nothing')
function stuckOn(rec) {
  if (!unfinished(rec)) return ''
  const before = ledger.filter((x) => x !== rec && kindOf(x.job) === kindOf(rec.job) && x.seq < rec.seq).pop()
  if (!before || !unfinished(before)) return ''
  const what = `${rec.job.role}${isPackage(rec.job) ? ' PACKAGE' : ''} on ${rec.job.repo}`
  const text = `${whyNot(before)} ${whyNot(rec)}`
  return `${what} could not finish twice in a row (${before.job.id}, ${rec.job.id}) and was not sent a third time.\n1. ${before.job.id}: ${whyNot(before)}\n2. ${rec.job.id}: ${whyNot(rec)}\n` +
    (/classifier|permission|not allowed|denied|auto.?mode|approval/i.test(text)
      ? 'This looks like a tool-permission block, not a code problem: check the session\'s permission mode and any hook that rewrites commands, then run the command again.'
      : 'What it needs is outside the task (environment, access, a decision): fix that, then run the command again.')
}
// PM model: turn 1 is opus (sizing and planning need judgement). After that XS/S tasks run the PM on
// sonnet; M/L stay on opus. A guard violation puts the PM back on opus for the retry.
let size = ''
// Plan check: on M/L build/qc runs the first plan is read once by tf:reviewer, on the PM's model, against
// the ticket (missing requirements, a repo left out, assumptions the ticket contradicts). It cannot block:
// the PM fixes plan.md or records why not, once, and the run goes on.
let planChecked = !['build', 'qc'].includes(mode) || !!A.approved
let planNotes = ''
let designGate = ['build', 'qc'].includes(mode) && !A.approved && !flags.assume
let planAsked = false // the PM answers plan-check points this turn
const planFile = `${dir}/jobs/J0-reviewer-plan.md`
const RULES = CODE_MODES.includes(mode)
  ? `Hard rules the executor enforces (a decision that breaks one is rejected and costs a turn): at most ${MAX_JOBS} jobs per dispatch and ${MAX_GROUP} per group; ONE dev job per repo per group, ${MAX_DEV_PER_REPO} per repo per run; ` +
    `a tester or reviewer never shares a group with a dev job on its repo (a FLOWS tester may); a reviewer gate never shares a group with a tester of its repo; ` +
    `a gate runs on the model of that repo's last dev job, whatever model you give it; on M/L a PACKAGE job needs a gate SHIP after that repo's last dev job; on XS/S the gate may be left out (dev → tester → PACKAGE in one dispatch: the PACKAGE job gates first, and a dev job that changed more than ${FAST_FILES} files stops the dispatch for a gate); no FLOWS job on XS or in a fix round; XS is one repo; close needs, for EACH changed repo on its own, a tester PASS after that repo's last dev job and then a PACKAGE reviewer SHIP with a ready PR started after that PASS.\n`
  : ''
// e2e with approved cases: nothing is left to judge but the dispatch and the reports — sonnet; writing the
// cases (no snapshot yet) stays on opus.
const pmModel = (turn) => (snapshot ? (violation ? 'opus' : 'sonnet') : turn === 1 || violation || !['XS', 'S'].includes(size) ? 'opus' : 'sonnet')
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  if (budgetLow()) return { status: 'handoff', slug, round, mode, note: 'token budget low — relaunch with the same args; the PM resumes from board.md' }
  phase('PM')
  const pmPrompt =
    `${context}\n\nPM turn ${turn}/${MAX_TURNS}. Allowed roles in this mode: ${ROLES[mode].join(', ')}.\n` +
    (turn === 1
      ? (A.format === 'old' ? 'This folder has the old layout (STATUS.md/spec.md, no HANDOFF.md): build HANDOFF.md/board.md from them first, keep only what the new round needs.\n' : '') +
        (A.approved && !snapshot ? 'The user approved plan.md — dispatch it.\n' : '') +
        (mode === 'e2e'
          ? (snapshot
            ? `The user approved the test cases (${snapshot}). Do NOT analyse the task again: dispatch setup only if this task's resources are missing, then tester job(s) whose "cases" cover the run scope (${runScope.join(', ')}). ` +
              `At close run node ${S}/cases.mjs results ${dir} --write and use what it decides (pm.md "e2e: cases").\n`
            : `E2E test cases first (pm.md "e2e: cases"): write ${dir}/cases.md and return decision=cases with caseIds, questions (each naming the cases it affects), missingSpecs and target. Dispatch nothing — the user reviews and approves the cases before any job runs.` +
              (flags.assume ? ' The user passed --assume: no questions — assume and mark the case ⚠; the cases are approved as you write them.' : clarifyRound ? ` The user answered earlier questions (ticket.md "## Clarifications") — never ask those again${clarifyRound >= MAX_CLARIFY ? '; no more questions' : ''}.` : '') +
              (editRound ? ` The user edited the cases ${editRound} time(s): keep their edits, change only what the new answers or specs require.` : '') + '\n')
          : flags.assume
          ? 'The user passed --assume: do not ask (no clarify) — decide every open point yourself and list it under Assumptions and in scope.\n'
          : clarifyRound
            ? `The user answered your earlier questions (ticket.md "## Clarifications") — never ask those again. ${clarifyRound >= MAX_CLARIFY ? 'No more questions: assume what is still open, or escalate if it cannot be assumed.' : 'Ask again (clarify) only for something those answers opened up.'}\n`
            : 'Understand before you plan (pm.md "Clear or not"): if the brief leaves open something that changes what gets built, return clarify with the questions instead of planning; if it is clear, plan and say so in scope.\n') +
        (mode === 'feedback'
          ? `Feedback mode: read ${S}/../docs/pm-feedback.md first (its rules bind this run), then start from HANDOFF.md, board.md, feedback.md (NOT a QC round — do not re-plan ticket cases). Triage every point into feedback-triage.md${flags.check ? ', then return close (check = triage only)' : ', then plan only the fix points'}.\n`
          : 'Start from HANDOFF.md (if present), board.md, ticket.md (new comments are marked), then plan.\n')
      : `Reports from the last dispatch:\n${JSON.stringify(last.map(compact))}\n`) +
    (planNotes ? `Plan check (${planFile}) — your last decision was NOT executed. Points raised:\n${planNotes}\nFor each point: fix plan.md, or write under board.md Decisions why the plan stands (a point without a ticket quote may be dropped). Then return your decision again, with planKept = one line per point where the plan stays as it was (the user is asked about those before any job runs).\n` : '') +
    (mode === 'feedback' && turn > 1 ? `Feedback mode rules: ${S}/../docs/pm-feedback.md.\n` : '') +
    (stuck ? `STUCK — the run stops after this turn: ${stuck}\nDo not dispatch anything. Update board.md (the two jobs, what they needed), write HANDOFF.md (Status: escalated) and return escalate with the one thing the user must do.\n` : '') +
    (violation ? `REJECTED last decision: ${violation}\nFix it this turn.\n` : '') +
    (turn === 1 || violation ? RULES : '') +
    (turn === 1 && designGate ? 'Size L: write design.md before plan.md (pm.md "Documents by size"); the run stops after your first decision so the user reads both before any job starts.\n' : '') +
    (turn >= MAX_TURNS - 1 ? 'Last turns left: close or escalate now.\n' : '') +
    'Update board.md, then return your decision.'
  const model = pmModel(turn)
  const d = await run(pmPrompt, { agentType: `${AP}pm`, model, label: `PM t${turn} (${model})`, phase: 'PM', schema: DISPATCH })
  if (!d) return { status: 'error', stage: `pm t${turn}`, slug }
  if (d.size) size = d.size
  log(`PM t${turn} [${d.size}] ${d.decision}: ${d.note}`)
  if (stuck) return { status: 'escalate', slug, round, mode, question: stuck + (d.decision === 'escalate' && d.escalate ? `\nPM: ${d.escalate}` : '') }
  // e2e: the test cases (and the questions and missing specs that come with them) go to the user before any job.
  if (d.decision === 'cases' || (mode === 'e2e' && !snapshot && d.decision === 'clarify')) {
    const qs = (d.questions || []).filter((q) => q && q.question)
    const ids = (d.caseIds || []).map(String).filter(Boolean)
    violation = mode !== 'e2e' ? 'decision=cases is for e2e only'
      : snapshot ? 'the cases are already approved — dispatch the run scope'
      : d.decision === 'clarify' ? 'in e2e the questions go with the cases: write cases.md and return decision=cases with the questions'
      : !ids.length ? 'decision=cases needs caseIds: the internal ids of the cases you wrote to cases.md'
      : qs.length && flags.assume ? 'the user passed --assume: no questions — assume, mark the case ⚠ and record it under Assumptions'
      : qs.length && clarifyRound >= MAX_CLARIFY ? `the user already answered questions ${MAX_CLARIFY} times — assume what is left (⚠ on the case), or escalate the one point that cannot be assumed`
      : ''
    if (!violation) {
      return { status: 'cases', slug, round, mode, note: d.note, cases: `${dir}/cases.md`, caseIds: ids, questions: qs, missingSpecs: d.missingSpecs || [], target: d.target || '',
        clarifyRound: clarifyRound + (qs.length ? 1 : 0), editRound, assume: !!flags.assume }
    }
    strikes++
    log(`guard: ${violation}`)
    if (strikes >= 2) return { status: 'escalate', slug, round, mode, question: `PM decision rejected twice by the hard rules: ${violation}` }
    continue
  }
  // Unclear brief: the questions go to the user before plan.md, the plan check or any job. Only as the first
  // move of a run — once jobs ran, an open point is an escalation.
  if (d.decision === 'clarify') {
    const qs = (d.questions || []).filter((q) => q && q.question)
    violation = flags.assume ? 'the user passed --assume: no questions — decide, and record each guess under Assumptions'
      : ledger.length ? 'clarify is only for the first decision of a run, before any job — mid-run, decide and record the assumption, or escalate'
      : clarifyRound >= MAX_CLARIFY ? `the user already answered questions ${MAX_CLARIFY} times — assume what is left, or escalate the one point that cannot be assumed`
      : !qs.length ? 'decision=clarify needs at least one question' : ''
    if (!violation) return { status: 'clarify', slug, round, mode, note: d.note, questions: qs, clarifyRound: clarifyRound + 1 }
    strikes++
    log(`guard: ${violation}`)
    if (strikes >= 2) return { status: 'escalate', slug, round, mode, question: `PM decision rejected twice by the hard rules: ${violation}` }
    continue
  }
  // Two readers of the ticket still disagree after the PM answered the plan check: that is the moment to ask
  // the user, before any code is written. A plan the PM corrected, or a clean check, runs straight on.
  if (planAsked && !A.approved && Array.isArray(d.planKept) && d.planKept.length && (d.decision === 'dispatch' || d.decision === 'approve')) {
    log(`plan check: ${d.planKept.length} point(s) kept open by the PM → asking the user`)
    return { status: 'approve', slug, round, mode, note: d.note, scope: d.scope || '', planOpen: d.planKept, planCheck: planFile }
  }
  planAsked = false
  planNotes = ''
  if (!planChecked && (d.decision === 'dispatch' || d.decision === 'approve')) {
    planChecked = true
    if (d.scope) log(`scope: ${d.scope}`)
    if (['M', 'L'].includes(d.size)) {
      const pc = await run(
        `Job J0 · role reviewer · PLAN check\n${context}\n\n` +
          `Brief: PLAN (reviewer.md "Plan check"). The PM wrote ${dir}/plan.md${d.size === 'L' ? ` and ${dir}/design.md (size L: the design comes first — a missing or empty design.md is a point)` : ''} from ${dir}/ticket.md; no code exists yet. Check ${d.size === 'L' ? 'both' : 'the plan'} against the ticket and the workspace config. No git, no code edits, do not rewrite the plan.\n` +
          `Write your report to ${planFile} (heredoc) and append one line: node ${S}/task.mjs journal ${dir} "J0 reviewer plan: <one-line result>". Return the structured report; reportFile = that path; verdict SHIP when you found nothing, NEEDS-WORK otherwise, issues = the points (PP<n>).`,
        { label: 'J0 reviewer:plan', phase: 'PM', model, schema: REPORT, agentType: AGENT.reviewer })
      const points = (pc && pc.issues) || []
      if (pc && pc.verdict !== 'SHIP' && points.length) {
        log(`plan check: ${points.length} point(s) → back to the PM`)
        planNotes = points.map((p) => `- ${p}`).join('\n')
        planAsked = true
        continue
      }
      log(pc ? 'plan check: nothing found' : 'plan check: no report — going on with the plan as it is')
    }
  }

  // Size L (build/qc): the design and the plan are shown to the user before the first job — a wrong design on
  // a large task costs rounds, not minutes. Once per task round; --assume and an earlier approval skip it.
  if (designGate && (d.decision === 'dispatch' || d.decision === 'approve')) {
    designGate = false
    if (d.size === 'L') {
      log('size L: design.md and plan.md go to the user before any job')
      return { status: 'approve', slug, round, mode, size: 'L', note: d.note, scope: d.scope || '', design: `${dir}/design.md` }
    }
  }

  if (d.decision === 'escalate') return { status: 'escalate', slug, round, mode, question: d.escalate || d.note }
  if (d.decision === 'approve') {
    if (flags.approve && !A.approved) return { status: 'approve', slug, round, mode, note: d.note }
    violation = 'no approval was requested (or it was already given) — dispatch the plan'
  } else if (d.decision === 'close') {
    violation = checkClose(d)
    if (!violation) {
      return { status: mode === 'feedback' && flags.check ? 'triaged' : DONE_STATUS[mode], slug, round, mode, size: d.size, close: d.close || {}, jobs: ledger.map(compact) }
    }
  } else {
    violation = checkDispatch(d)
    if (!violation) {
      strikes = 0
      d.jobs.forEach((j) => seenIds.add(j.id))
      const groups = [...new Set(d.jobs.map((j) => j.group))].sort((a, b) => a - b)
      last = []
      // IMPACT lines of this dispatch's gates (other users of the changed code that no case covers) become
      // cases of the testers that run after them, for the same repo.
      const impact = []
      phase('Jobs')
      for (const g of groups) {
        seq++
        const batch = d.jobs.filter((j) => j.group === g).map((j) => ({ ...j, _seq: seq,
          _impact: impact.filter((x) => j.repo === 'all' || x.repo === 'all' || x.repo === j.repo).map((x) => x.line) }))
        // Several testers at once: one of them owns the shared flow library, the others only read it.
        const testers = batch.filter((j) => j.role === 'tester')
        if (testers.length > 1) testers.forEach((j, i) => { j._lib = i ? 'reader' : 'owner'; j._libOwner = testers[0].id })
        const recs = (await parallel(batch.map((j) => () => runJob(j, turn)))).filter(Boolean)
        last.push(...recs)
        stuck = recs.map(stuckOn).filter(Boolean).join('\n')
        if (stuck) { log(`stuck: ${stuck.split('\n')[0]}`); break }
        for (const r of recs) if (r.job.role === 'reviewer' && !isPackage(r.job) && r.report)
          for (const line of r.report.issues || []) if (/^\s*IMPACT\d*\b/.test(line)) impact.push({ repo: r.job.repo, line })
        // A later group usually depends on this one (judges after devs): stop and let the PM decide.
        const broken = recs.filter(stopsLaterGroups)
        const skipped = groups.filter((x) => x > g)
        const big = ['XS', 'S'].includes(size) ? recs.filter((r) => r.job.role === 'dev' && r.report && r.report.status === 'done' &&
          (r.report.filesChanged || []).length > FAST_FILES && !d.jobs.some((x) => isGate(x) && sameRepo(x.repo, r.job.repo) && x.group > g)) : []
        if (!broken.length && big.length && skipped.length) {
          const why = `not run: the small-task lane (no separate gate) is for changes of at most ${FAST_FILES} files — ${big.map((r) => `${r.job.repo} changed ${r.report.filesChanged.length}`).join(', ')}. Dispatch gate → tester → PACKAGE for it.`
          log(`group ${g}: ${why}`)
          const left = d.jobs.filter((j) => skipped.includes(j.group))
          last.push(...left.map((j) => ({ job: j, report: { status: 'failed', verdict: 'NONE', summary: why }, turn, seq })))
          left.forEach((j) => seenIds.delete(j.id))
          break
        }
        if (broken.length && skipped.length) {
          const left = d.jobs.filter((j) => skipped.includes(j.group)).map((j) => j.id)
          log(`group ${g}: ${broken.map((r) => `${r.job.id}${r.report && r.report.status === 'done' ? ` ${r.report.verdict}` : ' not done'}`).join(', ')} → skipped ${left.join(', ')}`)
          last.push(...d.jobs.filter((j) => skipped.includes(j.group)).map((j) => ({ job: j, report: { status: 'failed', verdict: 'NONE', summary: 'not run: an earlier group in this dispatch did not finish, its reviewer gate asked for changes, or its tester did not PASS' }, turn, seq })))
          left.forEach((id) => seenIds.delete(id))
          break
        }
      }
      continue
    }
  }
  strikes++
  log(`guard: ${violation}`)
  if (strikes >= 2) return { status: 'escalate', slug, round, mode, question: `PM decision rejected twice by the hard rules: ${violation}` }
}
return { status: 'escalate', slug, round, mode, question: `PM did not close within ${MAX_TURNS} turns — see board.md` }
