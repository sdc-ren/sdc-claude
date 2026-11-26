// tf — the shared commands of `tf <command>`: each one is a module's own command line, by name. A host adds
// its own commands (hosts/<agent>/tf.mjs) on top of these; nothing here is specific to a coding agent.
// The names are the old script names (scripts/<name>.mjs), so `node <plugin>/scripts/task.mjs resolve …` and
// `tf task resolve …` are the same command.
export const COMMANDS = {
  // task identity, input and lifecycle
  task: 'modules/task/task.mjs',
  sources: 'modules/task/sources.mjs',
  // resources a task holds
  resources: 'modules/resources/resources.mjs',
  reaper: 'modules/resources/reaper.mjs',
  // worktrees and dependencies
  pool: 'modules/worktree/pool.mjs',
  fastdeps: 'modules/worktree/fastdeps.mjs',
  fresh: 'modules/worktree/fresh.mjs',
  // running the app: servers, emulators, APKs
  serve: 'modules/env/serve.mjs',
  emulator: 'modules/env/emulator.mjs',
  apk: 'modules/env/apk.mjs',
  // the task's own browser, signed-in sessions
  browser: 'modules/browser/browser.mjs',
  // e2e: cases, flows, evidence
  cases: 'modules/e2e/cases.mjs',
  'flow-run': 'modules/e2e/flow-run.mjs',
  'flow-peek': 'modules/e2e/flow-peek.mjs',
  annotate: 'modules/e2e/annotate.mjs',
  webp: 'modules/e2e/webp.mjs',
  // review, git conventions, PR feedback
  'security-scan': 'modules/review/security-scan.mjs',
  naming: 'modules/vcs/naming.mjs',
  'pr-feedback': 'modules/vcs/pr-feedback.mjs',
  // trackers, chats, designs
  jira: 'modules/tracker/jira.mjs',
  zalo: 'modules/chat/zalo.mjs',
  canvas: 'modules/design/canvas.mjs',
  // workspace setup and knowledge maps
  init: 'modules/knowledge/init.mjs',
  knowledge: 'modules/knowledge/gen.mjs',
  // this machine
  platform: 'core/platform.mjs',
}
