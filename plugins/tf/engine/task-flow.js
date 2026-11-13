// SDC tf plugin — task-flow PM-led executor. Launched by the /tf:build|qc|feedback|review|e2e skills (docs/orchestrator.md); design in docs/design.md.
//
// The PM (tf:pm) decides every step: it reads the task, writes the plan, returns a dispatch (jobs, roles,
// models, parallel groups). This script runs the jobs, enforces the hard rules, hands the reports back to
// the PM, and repeats until the PM closes or escalates. No filesystem here: agents write their own files,
// the orchestrator handles lock/unlock and close-out around the run.
//
// args: { root, slug, dir, mode: 'build'|'qc'|'feedback'|'review'|'e2e', round, input, description?, cases?, notes?,
//         prs?: {repo: url}, worktrees?: {repo: path|null}, worktreePaths?: {repo: path}, format?: 'new'|'old'|'current',
//         flags?: { approve?: bool, draft?: bool, check?: bool (feedback: triage only) }, approved?: bool, lang?, writingLang?, scripts, config }
// returns { status: 'done'|'triaged'|'verified'|'reviewed'|'escalate'|'approve'|'handoff'|'error', … }

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
const RESERVE = 80_000

const ROLES = {
  build: ['setup', 'dev', 'tester', 'reviewer'],
  qc: ['setup', 'dev', 'tester', 'reviewer'],
  feedback: ['setup', 'dev', 'tester', 'reviewer'],
  review: ['setup', 'tester', 'reviewer'],
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
    decision: { type: 'string', enum: ['dispatch', 'close', 'escalate', 'approve'] },
    size: { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    note: { type: 'string', description: 'One or two lines: what this turn decided and why.' },
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
    issues: { type: 'array', items: { type: 'string' }, description: 'Stable ids: IB<n> (tester), QP<n> [P0-P2] (reviewer), RISK<n>.' },
    cases: { type: 'array', items: { type: 'string' }, description: 'tester: "case | PASS|Failed — BUG: impact|Not tested — reason | evidence files"' },
    repo: { type: 'string' },
    prUrl: { type: 'string' },
    prDraft: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'array', items: { type: 'string' } },
    reportFile: { type: 'string' },
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
const lang = A.lang || 'en'
const writingLang = A.writingLang || 'en'
const prs = A.prs || {}
const worktrees = A.worktrees || {}
if (!root || !slug || !dir || !S || !cfg) return { status: 'error', note: 'args need { root, slug, dir, scripts, config } — see the header of workflow.mjs' }
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
  (A.cases ? `Target cases: ${A.cases}\n` : '') + (A.notes ? `User notes: ${A.notes}\n` : '') +
  `PRs: ${JSON.stringify(prs)}\nWorktrees (existing): ${JSON.stringify(worktrees)}\nWorktree paths (one folder per task, one subfolder per repo — use exactly these): ${JSON.stringify(A.worktreePaths || {})}\n` +
  `Flags: approve=${!!flags.approve} draft=${!!flags.draft}${mode === 'feedback' ? ` check=${!!flags.check}` : ''}\n` +
  (mode === 'feedback' ? `PR feedback: ${dir}/feedback.md (fetched review threads R<n>, reviews, conversation comments) · triage: ${dir}/feedback-triage.md · reply drafts: ${dir}/feedback-replies.md\n` : '') +
  (Array.isArray(A.attachments) && A.attachments.length
    ? `Attachments (read the files; the design system binds UI work): ${A.attachments.map((x) => `${x.kind}: ${x.title} → ${x.file}`).join(' · ')}\n`
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
// code that is about to change, so they are skipped and the PM re-plans.
const stopsLaterGroups = (r) =>
  !isFlows(r.job) && (!r.report || r.report.status !== 'done' ||
  (r.job.role === 'reviewer' && !isPackage(r.job) && mode !== 'review' && ['NEEDS-WORK', 'BLOCK'].includes(r.report.verdict)))

function checkDispatch(d) {
  if (mode === 'feedback' && flags.check) return '--check is triage only: write feedback-triage.md and return close, no jobs'
  const jobs = d.jobs || []
  if (!jobs.length) return 'decision=dispatch needs at least one job'
  if (jobs.length > MAX_JOBS) return `at most ${MAX_JOBS} jobs per dispatch (got ${jobs.length}) — dispatch the first groups now, the rest next turn`
  for (const j of jobs) {
    if (!ROLES[mode].includes(j.role)) return `role ${j.role} is not allowed in mode ${mode} (allowed: ${ROLES[mode].join(', ')})`
    if (seenIds.has(j.id)) return `job id ${j.id} already used — continue the numbering`
    if (j.role === 'dev' && (!j.repo || j.repo === 'all')) return `dev job ${j.id} must name one repo`
  }
  const ids = jobs.map((j) => j.id)
  if (new Set(ids).size !== ids.length) return 'duplicate job ids in one dispatch'
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
  if (mode === 'e2e') return ledger.some((x) => x.job.role === 'tester' && !isFlows(x.job) && ok(x)) ? '' : 'e2e cannot close without a finished tester job'
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
        `For dependencies try node ${S}/fastdeps.mjs first (see config). Register every resource with node ${S}/resources.mjs add. ` +
        (mode === 'review' || mode === 'e2e'
          ? `Mode ${mode}: check out the code under test (the PR head, \`git fetch origin pull/<n>/head\`, or its branch) DETACHED in the task worktree — never create a branch, never commit. `
          : '') +
        `Start the app servers the plan needs with node ${S}/serve.mjs start ${root} ${slug} (config "## Servers"; it waits for each health check) and LEAVE THEM RUNNING — ` +
        `later jobs reuse them and the orchestrator stops them at run end. A config without "## Servers": smoke-check backend/frontend by hand, then stop what you started. ` +
        `Emulator + APK only when the plan needs the App (stop the emulator when done).\n`
      : '') +
    (isFlows(j)
      ? `FLOWS job: the code is being changed right now by the dev job(s) of this group. Write the flows only (tester.md "FLOWS briefs"); do not judge the app, return verdict NONE.\n`
      : '') +
    (j.role === 'dev' || j.role === 'tester' ? serversLine : '') +
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
async function runDev(j) {
  const model = MODELS.includes(j.model) ? j.model : 'sonnet'
  const head = `Job ${j.id} · role dev lead · repo ${j.repo}\n${context}\n\n` +
    `Brief: ${j.brief}\nRead first: ${(j.reads || []).join(', ') || 'plan.md section for your repo'}\nDone when: ${j.doneWhen}\n` +
    `Worktree: ${worktreeOf(j.repo)} · existing PR: ${prs[j.repo] || 'none'}\n` + serversLine
  const teamFile = `${dir}/jobs/${j.id}-team-${j.repo}.md`
  const ask = (why) => run(
    head + `You lead this repo's dev work for this job (lead.md). Decide first: do it yourself, or split it among 2–${MAX_MEMBERS} members who work in this worktree at the same time.\n` +
      `· Yourself (split=false): implement the job now as a developer. ${reportLine(j.id, 'dev', j.repo)}\n` +
      `· Team (split=true): write NO code. Write the team plan to ${teamFile} (members, their micro-tasks and files, the interfaces between them) and return members + interfaces.\n` +
      (why ? `REJECTED team: ${why}. Return a valid team, or split=false and do the job yourself.\n` : ''),
    { label: `${j.id} lead:${j.repo}`, phase: 'Jobs', model, schema: LEAD, agentType: AGENT.lead, ...(j.effort ? { effort: j.effort } : {}) })
  let plan = await ask('')
  if (!plan) return null
  const solo = (p) => ({ verdict: 'NONE', ...p, status: p.status || 'failed' })
  if (!plan.split) return solo(plan)
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
  return merged || failed(`dev lead did not return after its members (${got.map((g) => `${g.id} ${g.status}`).join(', ')})`)
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
    if (j.role === 'reviewer' && !isPackage(j) && CODE_MODES.includes(mode)) {
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
// PM model: turn 1 is opus (sizing and planning need judgement). After that XS/S tasks run the PM on
// sonnet; M/L stay on opus. A guard violation puts the PM back on opus for the retry.
let size = ''
// Plan check: on M/L build/qc runs the first plan is read once by tf:reviewer, on the PM's model, against
// the ticket (missing requirements, a repo left out, assumptions the ticket contradicts). It cannot block:
// the PM fixes plan.md or records why not, once, and the run goes on.
let planChecked = !['build', 'qc'].includes(mode) || !!A.approved
let planNotes = ''
const planFile = `${dir}/jobs/J0-reviewer-plan.md`
const RULES = CODE_MODES.includes(mode)
  ? `Hard rules the executor enforces (a decision that breaks one is rejected and costs a turn): at most ${MAX_JOBS} jobs per dispatch and ${MAX_GROUP} per group; ONE dev job per repo per group, ${MAX_DEV_PER_REPO} per repo per run; ` +
    `a tester or reviewer never shares a group with a dev job on its repo (a FLOWS tester may); a reviewer gate never shares a group with a tester of its repo; ` +
    `a gate runs on the model of that repo's last dev job, whatever model you give it; close needs, for EACH changed repo on its own, a tester PASS after that repo's last dev job and then a PACKAGE reviewer SHIP with a ready PR started after that PASS.\n`
  : ''
const pmModel = (turn) => (turn === 1 || violation || !['XS', 'S'].includes(size) ? 'opus' : 'sonnet')
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  if (budgetLow()) return { status: 'handoff', slug, round, mode, note: 'token budget low — relaunch with the same args; the PM resumes from board.md' }
  phase('PM')
  const pmPrompt =
    `${context}\n\nPM turn ${turn}/${MAX_TURNS}. Allowed roles in this mode: ${ROLES[mode].join(', ')}. Design: ${S}/../docs/design.md.\n` +
    (turn === 1
      ? (A.format === 'old' ? 'This folder has the old layout (STATUS.md/spec.md, no HANDOFF.md): build HANDOFF.md/board.md from them first, keep only what the new round needs.\n' : '') +
        (A.approved ? 'The user approved plan.md — dispatch it.\n' : '') +
        (mode === 'feedback'
          ? `Feedback mode: start from HANDOFF.md, board.md, feedback.md (NOT a QC round — do not re-plan ticket cases). Triage every point into feedback-triage.md${flags.check ? ', then return close (check = triage only)' : ', then plan only the fix points'}.\n`
          : 'Start from HANDOFF.md (if present), board.md, ticket.md (new comments are marked), then plan.\n')
      : `Reports from the last dispatch:\n${JSON.stringify(last.map(compact))}\n`) +
    (planNotes ? `Plan check (${planFile}) — your last decision was NOT executed. Points raised:\n${planNotes}\nFor each point: fix plan.md, or write under board.md Decisions why the plan stands (a point without a ticket quote may be dropped). Then return your decision again.\n` : '') +
    (violation ? `REJECTED last decision: ${violation}\nFix it this turn.\n` : '') +
    (turn === 1 || violation ? RULES : '') +
    (turn >= MAX_TURNS - 1 ? 'Last turns left: close or escalate now.\n' : '') +
    'Update board.md, then return your decision.'
  const model = pmModel(turn)
  const d = await run(pmPrompt, { agentType: `${AP}pm`, model, label: `PM t${turn} (${model})`, phase: 'PM', schema: DISPATCH })
  if (!d) return { status: 'error', stage: `pm t${turn}`, slug }
  if (d.size) size = d.size
  log(`PM t${turn} [${d.size}] ${d.decision}: ${d.note}`)
  planNotes = ''
  if (!planChecked && (d.decision === 'dispatch' || d.decision === 'approve')) {
    planChecked = true
    if (d.scope) log(`scope: ${d.scope}`)
    if (['M', 'L'].includes(d.size)) {
      const pc = await run(
        `Job J0 · role reviewer · PLAN check\n${context}\n\n` +
          `Brief: PLAN (reviewer.md "Plan check"). The PM wrote ${dir}/plan.md from ${dir}/ticket.md; no code exists yet. Check the plan against the ticket and the workspace config. No git, no code edits, do not rewrite the plan.\n` +
          `Write your report to ${planFile} (heredoc) and append one line: node ${S}/task.mjs journal ${dir} "J0 reviewer plan: <one-line result>". Return the structured report; reportFile = that path; verdict SHIP when you found nothing, NEEDS-WORK otherwise, issues = the points (PP<n>).`,
        { label: 'J0 reviewer:plan', phase: 'PM', model, schema: REPORT, agentType: AGENT.reviewer })
      const points = (pc && pc.issues) || []
      if (pc && pc.verdict !== 'SHIP' && points.length) {
        log(`plan check: ${points.length} point(s) → back to the PM`)
        planNotes = points.map((p) => `- ${p}`).join('\n')
        continue
      }
      log(pc ? 'plan check: nothing found' : 'plan check: no report — going on with the plan as it is')
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
      phase('Jobs')
      for (const g of groups) {
        seq++
        const batch = d.jobs.filter((j) => j.group === g).map((j) => ({ ...j, _seq: seq }))
        const recs = (await parallel(batch.map((j) => () => runJob(j, turn)))).filter(Boolean)
        last.push(...recs)
        // A later group usually depends on this one (judges after devs): stop and let the PM decide.
        const broken = recs.filter(stopsLaterGroups)
        const skipped = groups.filter((x) => x > g)
        if (broken.length && skipped.length) {
          const left = d.jobs.filter((j) => skipped.includes(j.group)).map((j) => j.id)
          log(`group ${g}: ${broken.map((r) => `${r.job.id}${r.report && r.report.status === 'done' ? ` ${r.report.verdict}` : ' not done'}`).join(', ')} → skipped ${left.join(', ')}`)
          last.push(...d.jobs.filter((j) => skipped.includes(j.group)).map((j) => ({ job: j, report: { status: 'failed', verdict: 'NONE', summary: 'not run: an earlier group in this dispatch did not finish or its reviewer gate asked for changes' }, turn, seq })))
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
