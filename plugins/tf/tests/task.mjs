// task.mjs lock/unlock (atomic, token-owned) and the commit fingerprint a run records.
// Run: node --test plugins/tf/tests/task.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const T = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'task.mjs')
const cli = (...a) => { const r = spawnSync(process.execPath, [T, ...a], { encoding: 'utf8' }); return { code: r.status, json: JSON.parse(r.stdout || 'null') } }

test('lock is taken once, renewed and released only with its token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-lock-'))
  const a = cli('lock', dir).json
  assert.equal(a.conflict, false); assert.ok(a.token)
  const b = cli('lock', dir).json
  assert.equal(b.conflict, true); assert.equal(b.stale, false)
  assert.equal(cli('lock', dir, '--token', a.token).json.renewed, true)
  const wrong = cli('unlock', dir, '--token', 'nope')
  assert.equal(wrong.code, 1); assert.equal(wrong.json.unlocked, false)
  assert.equal(cli('unlock', dir, '--token', a.token).json.unlocked, true)
  assert.equal(cli('lock', dir).json.conflict, false)
})

test('an expired lock is reported stale and taken only with --steal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-lock-'))
  const a = cli('lock', dir).json
  const old = new Date(Date.now() - 2 * 3600 * 1000)
  utimesSync(join(dir, '.lock'), old, old)
  const b = cli('lock', dir).json
  assert.equal(b.conflict, true); assert.equal(b.stale, true)
  const c = cli('lock', dir, '--steal').json
  assert.equal(c.conflict, false); assert.notEqual(c.token, a.token)
  assert.equal(cli('unlock', dir, '--token', a.token).json.unlocked, false)
})

test('a lock written before tokens existed can still be released', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-lock-'))
  writeFileSync(join(dir, '.lock'), JSON.stringify({ startedAt: 1, pid: 1 }))
  assert.equal(cli('unlock', dir).json.unlocked, true)
})

test('commit: the HEAD of every task worktree, plus a fingerprint when there are uncommitted changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-commit-'))
  const dir = join(root, '.pipeline', 'T-1'); mkdirSync(dir, { recursive: true })
  assert.equal(cli('commit', dir).json.commit, '')
  const wt = join(root, '.worktrees', 'T-1', 'be'); mkdirSync(wt, { recursive: true })
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { stdio: 'pipe' })
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
  const clean = cli('commit', dir).json.commit
  assert.match(clean, /^be:[0-9a-f]{10}$/)
  writeFileSync(join(wt, 'a.txt'), 'changed')
  const dirty = cli('commit', dir).json.commit
  assert.match(dirty, /^be:[0-9a-f]{10}\*[0-9a-f]{8}$/)
  writeFileSync(join(wt, 'a.txt'), 'changed again')
  assert.notEqual(cli('commit', dir).json.commit, dirty)
})

test('config prints only the sections a role needs, plus Hard rules, and names what is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-cfg-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'task-flow.md'), '# cfg\n\n## Repos\n- be\n\n## Servers (`serve.mjs`)\nbe: npm start\n\n## Flows (e2e)\nlogin recipe\n\n## Hard rules\n- never X\n')
  const r = spawnSync(process.execPath, [T, 'config', root, '--role', 'tester'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^## Flows \(e2e\)\nlogin recipe\n\n## Servers/)
  assert.match(r.stdout, /## Hard rules\n- never X/)
  assert.doesNotMatch(r.stdout, /## Repos/)
  assert.match(r.stdout, /no section in .*: Test policy/)
  const dev = spawnSync(process.execPath, [T, 'config', root, '--role', 'dev'], { encoding: 'utf8' }).stdout
  assert.match(dev, /no section in .*Team agreements/)
  const one = spawnSync(process.execPath, [T, 'config', root, 'repos'], { encoding: 'utf8' }).stdout
  assert.match(one, /^## Repos\n- be/)
})
