// SDC tf plugin — task-flow v2 PM-led executor. Launched by the /tf:build|qc|review|e2e skills (docs/orchestrator.md); design in docs/design.md.
//
// The PM (tf:pm) decides every step: it reads the task, writes the plan, returns a dispatch (jobs, roles,
// models, parallel groups). This script runs the jobs, enforces the hard rules, hands the reports back to
// the PM, and repeats until the PM closes or escalates. No filesystem here: agents write their own files,
// the orchestrator handles lock/unlock and close-out around the run.
//
// args: { root, slug, dir, mode: 'build'|'qc'|'review'|'e2e', round, input, description?, cases?, notes?,
//         prs?: {repo: url}, worktrees?: {repo: path|null}, worktreePaths?: {repo: path}, format?: 'new'|'v1'|'v2',
//         flags?: { approve?: bool, draft?: bool }, approved?: bool, lang?, writingLang?, scripts, config }
// returns { status: 'done'|'verified'|'reviewed'|'escalate'|'approve'|'handoff'|'error', … }

export const meta = {
  name: 'task-flow',
  description: 'PM-led task pipeline: PM plans and dispatches dev/tester/reviewer jobs until the task closes',
  whenToUse: 'Internal engine of /tf:build, /tf:qc, /tf:review, /tf:e2e — launched by those skills with args; do not run it directly.',
  phases: [
    { title: 'PM', detail: 'tf:pm reads the task, plans, dispatches, reviews reports, closes' },
    { title: 'Jobs', detail: 'setup / dev / tester / reviewer jobs from the PM dispatch, parallel per group' },
  ],
}

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_TURNS = 10
const MAX_JOBS = 6
const MAX_DEV_PER_REPO = 4
const RESERVE = 80_000

const ROLES = {
  build: ['setup', 'dev', 'tester', 'reviewer'],
  qc: ['setup', 'dev', 'tester', 'reviewer'],
  review: ['setup', 'tester', 'reviewer'],
  e2e: ['setup', 'tester'],
}
const DONE_STATUS = { build: 'done', qc: 'done', review: 'reviewed', e2e: 'verified' }
const MODELS = ['haiku', 'sonnet', 'opus']

// ── Schemas ──────────────────────────────────────────────────────────────────
const DISPATCH = {
  type: 'object',
  required: ['decision', 'size', 'note'],
  properties: {
    decision: { type: 'string', enum: ['dispatch', 'close', 'escalate', 'approve'] },
    size: { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    note: { type: 'string', description: 'One or two lines: what this turn decided and why.' },
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
        noChange: { type: 'string', description: 'build/qc only: why no code change is needed (no dev job this run).' },
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
const tok = []
async function run(prompt, opts) {
  const before = budget.spent()
  const out = await agent(prompt, opts)
  tok.push(`${opts.label}=${Math.round((budget.spent() - before) / 1000)}k`)
  return out
}

// ── State of this run ────────────────────────────────────────────────────────
const ledger = [] // { job, report, turn, seq } — seq = index of the group the job ran in (groups run strictly in order)
const seenIds = new Set()
let seq = 0
const context =
  `Task ${slug} · mode ${mode} · round ${round}\nWorkspace root: ${root}\nTask folder: ${dir}\nWorkspace config: ${cfg}\nScripts: ${S}\n` +
  `Input: ${A.input || ''}\n` + (A.description ? `Description: ${A.description}\n` : '') +
  (A.cases ? `Target cases: ${A.cases}\n` : '') + (A.notes ? `User notes: ${A.notes}\n` : '') +
  `PRs: ${JSON.stringify(prs)}\nWorktrees (existing): ${JSON.stringify(worktrees)}\nWorktree paths (one folder per task, one subfolder per repo — use exactly these): ${JSON.stringify(A.worktreePaths || {})}\n` +
  `Flags: approve=${!!flags.approve} draft=${!!flags.draft}\n` +
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
function checkDispatch(d) {
  const jobs = d.jobs || []
  if (!jobs.length) return 'decision=dispatch needs at least one job'
  if (jobs.length > MAX_JOBS) return `at most ${MAX_JOBS} jobs per dispatch (got ${jobs.length})`
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
  for (const g of Object.values(byGroup)) {
    const devRepos = new Set(g.filter((j) => j.role === 'dev').map((j) => j.repo))
    const judge = g.find((j) => (j.role === 'tester' || j.role === 'reviewer') && (devRepos.has(j.repo) || (j.repo === 'all' && devRepos.size)))
    if (judge) return `${judge.id} (${judge.role}) runs in the same group as a dev job on ${judge.repo} — put judges in a later group`
  }
  return ''
}

function checkClose(d) {
  const c = d.close || {}
  const ok = (x) => x.report && x.report.status === 'done'
  if (mode === 'e2e') return ledger.some((x) => x.job.role === 'tester' && ok(x)) ? '' : 'e2e cannot close without a finished tester job'
  if (mode === 'review') return ledger.some((x) => x.job.role === 'reviewer' && ok(x)) ? '' : 'review cannot close without a finished reviewer job'
  const devs = ledger.filter((x) => x.job.role === 'dev')
  const covers = (x, repo) => x.job.repo === repo || x.job.repo === 'all' || x.report.repo === repo
  if (!devs.length) {
    if (!c.noChange) return 'build/qc close needs dev → tester PASS → reviewer package (SHIP + PR) in this run, or close.noChange with the reason no code change is needed'
    return ledger.some((x) => x.job.role === 'tester' && ok(x) && x.report.verdict === 'PASS') ? '' : 'close.noChange still needs a tester PASS in this run proving the current code already satisfies the task'
  }
  const devSeq = Math.max(...devs.map((x) => x.seq))
  const after = ledger.filter((x) => x.seq > devSeq)
  const testers = after.filter((x) => x.job.role === 'tester' && ok(x))
  const failing = testers.filter((x) => x.report.verdict !== 'PASS')
  if (failing.length) return `tester ${failing.map((x) => x.job.id).join(', ')} did not PASS on the latest code — fix or escalate`
  for (const repo of new Set(devs.map((x) => x.job.repo))) {
    const pass = testers.filter((x) => covers(x, repo))
    if (!pass.length) return `repo ${repo}: no tester PASS after its last dev job — test the latest code before closing`
    const passSeq = Math.min(...pass.map((x) => x.seq))
    const ship = after.find((x) => x.job.role === 'reviewer' && ok(x) && x.report.verdict === 'SHIP' && x.report.prUrl && covers(x, repo) && x.seq > passSeq)
    if (!ship) return `repo ${repo}: no reviewer PACKAGE job (SHIP + PR URL) started after the tester PASS — the PR must be pushed only after the latest code passed`
    if (ship.report.prDraft && !flags.draft) return `repo ${repo}: PR ${ship.report.prUrl} is a draft — PRs must be ready (the user did not pass --draft); have the reviewer mark it ready or escalate the blocker`
  }
  return ''
}

// ── Job runner ───────────────────────────────────────────────────────────────
// Agent types: plugin agents are namespaced <plugin>:<name>; override with args.agentPrefix (e.g. 'tf-' for a non-plugin install).
const AP = typeof A.agentPrefix === 'string' ? A.agentPrefix : 'tf:'
const AGENT = { dev: `${AP}dev`, tester: `${AP}tester`, reviewer: `${AP}reviewer` }
function jobPrompt(j) {
  const wt = worktrees[j.repo] || (A.worktreePaths && A.worktreePaths[j.repo]) || '(see HANDOFF.md / setup report)'
  return `Job ${j.id} · role ${j.role} · repo ${j.repo}\n${context}\n\n` +
    `Brief: ${j.brief}\nRead first: ${(j.reads || []).join(', ') || 'plan.md section for your repo'}\nDone when: ${j.doneWhen}\n` +
    (j.repo !== 'all' ? `Worktree: ${wt} · existing PR: ${prs[j.repo] || 'none'}\n` : '') +
    (j.role === 'setup'
      ? `You provision runtime resources for this task exactly as the workspace config "Provisioning" section says. Reuse everything the task already holds ` +
        `(node ${S}/resources.mjs list ${root}); worktrees go exactly to the paths listed above (<root>/.worktrees/<SLUG>/<repo dir>) — never another folder name. ` +
        `For dependencies try node ${S}/fastdeps.mjs first (see config). Register every resource with node ${S}/resources.mjs add. ` +
        (mode === 'review' || mode === 'e2e'
          ? `Mode ${mode}: check out the code under test (the PR head, \`git fetch origin pull/<n>/head\`, or its branch) DETACHED in the task worktree — never create a branch, never commit. `
          : '') +
        `Smoke-check what later jobs need (backend answers, frontend serves, emulator + APK when the plan needs the App), then stop what you started.\n`
      : '') +
    `Write your report to ${dir}/jobs/${j.id}-${j.role}-${j.repo}.md (heredoc) and append one line: node ${S}/task.mjs journal ${dir} "${j.id} ${j.role} ${j.repo}: <one-line result>". ` +
    `Return the structured report; reportFile = that path.`
}
async function runJob(j, turn) {
  const o = { label: `${j.id} ${j.role}:${j.repo}`, phase: 'Jobs', model: MODELS.includes(j.model) ? j.model : 'sonnet', schema: REPORT }
  if (AGENT[j.role]) o.agentType = AGENT[j.role]
  if (j.effort) o.effort = j.effort
  const report = await run(jobPrompt(j), o)
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
const pmModel = (turn) => (turn === 1 || violation || !['XS', 'S'].includes(size) ? 'opus' : 'sonnet')
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  if (budgetLow()) return { status: 'handoff', slug, round, mode, note: 'token budget low — relaunch with the same args; the PM resumes from board.md', tokens: tok }
  phase('PM')
  const pmPrompt =
    `${context}\n\nPM turn ${turn}/${MAX_TURNS}. Allowed roles in this mode: ${ROLES[mode].join(', ')}. Design: ${S}/../docs/design.md.\n` +
    (turn === 1
      ? (A.format === 'v1' ? 'This folder was made by task-flow v1 (STATUS.md/spec.md): build HANDOFF.md/board.md from them first, keep only what the new round needs.\n' : '') +
        (A.approved ? 'The user approved plan.md — dispatch it.\n' : '') +
        'Start from HANDOFF.md (if present), board.md, ticket.md (new comments are marked), then plan.\n'
      : `Reports from the last dispatch:\n${JSON.stringify(last.map(compact))}\n`) +
    (violation ? `REJECTED last decision: ${violation}\nFix it this turn.\n` : '') +
    (turn >= MAX_TURNS - 1 ? 'Last turns left: close or escalate now.\n' : '') +
    'Update board.md, then return your decision.'
  const model = pmModel(turn)
  const d = await run(pmPrompt, { agentType: `${AP}pm`, model, label: `PM t${turn} (${model})`, phase: 'PM', schema: DISPATCH })
  if (!d) return { status: 'error', stage: `pm t${turn}`, slug, tokens: tok }
  if (d.size) size = d.size
  log(`PM t${turn} [${d.size}] ${d.decision}: ${d.note}`)

  if (d.decision === 'escalate') return { status: 'escalate', slug, round, mode, question: d.escalate || d.note, tokens: tok }
  if (d.decision === 'approve') {
    if (flags.approve && !A.approved) return { status: 'approve', slug, round, mode, note: d.note, tokens: tok }
    violation = 'no approval was requested (or it was already given) — dispatch the plan'
  } else if (d.decision === 'close') {
    violation = checkClose(d)
    if (!violation) {
      return { status: DONE_STATUS[mode], slug, round, mode, size: d.size, close: d.close || {}, jobs: ledger.map(compact), tokens: tok }
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
        const broken = recs.filter((r) => !r.report || r.report.status !== 'done')
        const skipped = groups.filter((x) => x > g)
        if (broken.length && skipped.length) {
          const left = d.jobs.filter((j) => skipped.includes(j.group)).map((j) => j.id)
          log(`group ${g}: ${broken.map((r) => r.job.id).join(', ')} not done → skipped ${left.join(', ')}`)
          last.push(...d.jobs.filter((j) => skipped.includes(j.group)).map((j) => ({ job: j, report: { status: 'failed', verdict: 'NONE', summary: 'not run: an earlier group in this dispatch did not finish' }, turn, seq })))
          left.forEach((id) => seenIds.delete(id))
          break
        }
      }
      continue
    }
  }
  strikes++
  log(`guard: ${violation}`)
  if (strikes >= 2) return { status: 'escalate', slug, round, mode, question: `PM decision rejected twice by the hard rules: ${violation}`, tokens: tok }
}
return { status: 'escalate', slug, round, mode, question: `PM did not close within ${MAX_TURNS} turns — see board.md`, tokens: tok }
