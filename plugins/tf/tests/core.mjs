// tf — core layer: paths and config (new folders first, legacy still read), naming and guard rules in plain
// Node, and the old scripts/ entry points still giving the same functions.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as config from '../core/config.mjs'
import * as rules from '../core/guard-rules.mjs'
import * as naming from '../core/naming.mjs'
import * as paths from '../core/paths.mjs'
import * as platform from '../core/platform.mjs'
import * as oldNaming from '../scripts/naming.mjs'
import * as oldPlatform from '../scripts/platform.mjs'
import * as task from '../scripts/task.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'tf-core-'))

function withHome(home, fn) {
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  Object.assign(process.env, { HOME: home, USERPROFILE: home })
  try { return fn() } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('workspace config: <root>/.tf/config.md when it exists, else the legacy .claude/task-flow.md', () => {
  const root = tmp()
  assert.equal(paths.configPath(root), join(root, '.claude', 'task-flow.md'), 'nothing there: the legacy path, for messages')
  assert.equal(config.readConfig(root), '')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'task-flow.md'), '## Repos\nlegacy\n')
  assert.equal(paths.configPath(root), join(root, '.claude', 'task-flow.md'))
  assert.match(config.configSections(root, ['Repos']), /legacy/)
  mkdirSync(join(root, '.tf'))
  writeFileSync(join(root, '.tf', 'config.md'), '## Repos\nneutral\n\n## Hard rules\n- x\n')
  assert.equal(paths.configPath(root), join(root, '.tf', 'config.md'), 'the host-neutral file wins')
  const out = config.configSections(root, ['Repos'])
  assert.match(out, /neutral/)
  assert.doesNotMatch(out, /legacy/)
  assert.match(out, /## Hard rules/)
})

test('state folder: ~/.tf when it exists, else the legacy ~/.claude/task-flow', () => {
  const home = tmp()
  withHome(home, () => {
    assert.equal(paths.stateDir(), join(home, '.claude', 'task-flow'))
    mkdirSync(join(home, '.tf'))
    assert.equal(paths.stateDir(), join(home, '.tf'))
  })
})

test('the old entry points give the core functions', () => {
  assert.equal(oldNaming.checkTitle, naming.checkTitle)
  assert.equal(oldNaming.issueKey('PROJ-12'), 'PROJ-12')
  assert.equal(oldPlatform.under, platform.under)
  assert.equal(oldPlatform.stateDir, paths.stateDir)
  assert.equal(task.configSections, config.configSections)
  assert.equal(typeof oldPlatform.projectDirs, 'function', 'Claude transcripts still reachable from scripts/platform.mjs')
  assert.equal(typeof oldPlatform.info().claudeDir, 'string', 'doctor still reports the Claude data folder')
  assert.equal(platform.info().claudeDir, undefined, 'core reports no agent folder')
})

test('both platform command lines answer', () => {
  for (const file of ['core/platform.mjs', 'scripts/platform.mjs']) {
    const out = JSON.parse(execFileSync(process.execPath, [join(ROOT, file), 'info']).toString())
    assert.equal(out.os, platform.OS, file)
  }
  assert.match(platform.killCmd(1), /core\/platform\.mjs" kill 1$/)
})

test('guard rules run in plain Node, with no host', () => {
  const dev = rules.parseJob('Job J2 · role dev lead · repo be\nTask PROJ-7 · mode build · round 1\nWorktree: /r/.worktrees/PROJ-7/be · existing PR: none\n', 'tf:lead')
  assert.equal(dev.role, 'dev')
  assert.equal(dev.key, 'PROJ-7')
  assert.match(rules.check(dev, 'Bash', { command: 'git commit -m "feat(PROJ-7): x"' }), /never runs `git commit`/)
  assert.equal(rules.check(dev, 'Bash', { command: 'git status' }), '')
  const pm = rules.parseJob('Plan the task', 'tf:pm')
  assert.equal(pm.role, 'other')
  assert.match(rules.check(pm, 'Bash', { command: 'cat ~/.claude/task-flow/auth/jira.json' }), /saved logins/)
  assert.match(rules.check(pm, 'Read', { file_path: '/Users/me/.tf/auth/jira.json' }), /saved logins/, 'the host-neutral state folder is guarded too')
  assert.match(rules.check(pm, 'Bash', { command: 'gh pr merge 3' }), /never merges/)
  for (const cmd of ['node /p/scripts/pr-feedback.mjs post /t', 'node /p/modules/vcs/pr-feedback.mjs reply /t R1', 'node /p/cli/tf.mjs pr-feedback post /t', 'tf jira comment PROJ-1 --file c.md --confirm'])
    assert.match(rules.check(pm, 'Bash', { command: cmd }), /never posts/, `${cmd}: posting is refused whichever way the script is called`)
  assert.equal(rules.check(pm, 'Bash', { command: 'node /p/cli/tf.mjs pr-feedback fetch /t' }), '', 'reading the feedback is fine')
  assert.match(rules.check(pm, 'Bash', { command: 'gh pr create --title "feat: Thêm đăng nhập"' }), /English/)
  assert.equal(rules.parseJob('anything', 'general-purpose'), null, 'another agent is left alone')
})
