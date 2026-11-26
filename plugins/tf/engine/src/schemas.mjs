// tf engine — what the PM and every job must return. A host that can enforce a JSON schema on an agent's
// answer passes these as they are; one that cannot checks the answer against them itself.
import { MODELS } from './limits.mjs'

export const DISPATCH = {
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
          modelWhy: { type: 'string', description: 'Only when you pick a model above the default for the role (pm.md "Models"): one line why. A setup job runs on haiku without it.' },
          effort: { type: 'string', enum: ['low', 'medium', 'high'] },
          sensitive: { type: 'boolean', description: 'dev or gate job of a security-sensitive change (auth, roles, permissions, locks, money, audit, migrations — S1, S2, S7 of guidelines/review-standard.md): the gate of that repo runs on opus; the dev keeps its own model.' },
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
export const REPORT = {
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
export const LEAD = {
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
