// tf engine — the limits and the role table the hard rules are built from.
export const MAX_TURNS = 12
export const MAX_JOBS = 12 // jobs in one dispatch, all groups together
export const MAX_GROUP = 6 // jobs in one group, i.e. running at the same time
export const MAX_MEMBERS = 3 // dev members a repo's lead may run at once (one worktree, disjoint files)
export const MAX_DEV_PER_REPO = 6 // dev jobs per repo per run: the build plus the fix loop
export const FAST_FILES = 3 // small-task lane: a dev job that changed more files than this gets a gate before the tester
export const MAX_CLARIFY = 3 // times a task may go back to the user with questions before any job runs
export const RESERVE = 80_000

export const ROLES = {
  build: ['setup', 'dev', 'tester', 'reviewer'],
  qc: ['setup', 'dev', 'tester', 'reviewer'],
  feedback: ['setup', 'dev', 'tester', 'reviewer'],
  review: ['setup', 'reviewer'], // static: reading the code. Running the app is /tf:e2e, asked for on its own.
  e2e: ['setup', 'tester'],
}
export const DONE_STATUS = { build: 'done', qc: 'done', feedback: 'done', review: 'reviewed', e2e: 'verified' }
export const CODE_MODES = ['build', 'qc', 'feedback']
export const MODELS = ['haiku', 'sonnet', 'opus']
