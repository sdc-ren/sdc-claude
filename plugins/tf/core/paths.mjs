// tf core — where tf keeps its files, on the machine and in a workspace. Host-neutral names come first; the
// folders tf used before it ran on more than one coding agent are still read, so nothing has to move.
//
//   machine state (workspace list, saved logins, artifact index):
//     ~/.tf/                 when it exists
//     ~/.claude/task-flow/   otherwise (legacy, still the default until a migration moves it)
//   workspace config:
//     <root>/.tf/config.md   when it exists
//     <root>/.claude/task-flow.md   otherwise (legacy, still the default)
//
// The state folder is not taken from an environment variable: the tool guard (core/guard-rules.mjs) has to
// recognise the saved logins' path from a command's text alone, so the names stay fixed.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const STATE_DIR = '.tf'
export const LEGACY_STATE_DIR = join('.claude', 'task-flow')
export const CONFIG_FILE = join('.tf', 'config.md')
export const LEGACY_CONFIG_FILE = join('.claude', 'task-flow.md')

// tf's own machine-wide state folder.
export function stateDir() {
  const home = homedir()
  const neutral = join(home, STATE_DIR)
  return existsSync(neutral) ? neutral : join(home, LEGACY_STATE_DIR)
}

// The workspace config file of <root>, existing or not (callers report a missing one by this path).
export function configPath(root) {
  const r = resolve(String(root || '.'))
  const neutral = join(r, CONFIG_FILE)
  return existsSync(neutral) ? neutral : join(r, LEGACY_CONFIG_FILE)
}
