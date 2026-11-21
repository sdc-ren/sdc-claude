// resources.mjs: one holder per id across the workspace, and the status table.
// Run: node --test plugins/tf/tests/resources.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const R = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'resources.mjs')
const cli = (...a) => spawnSync(process.execPath, [R, ...a], { encoding: 'utf8', env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'tf-home-')) } })
const ws = () => mkdtempSync(join(tmpdir(), 'tf-res-'))
const cache = (root, slug, id) => cli('add', root, slug, '--kind', 'cache', '--id', id, '--release', `redis-cli -n ${id} FLUSHDB`)

test('an id another task holds is refused, with who holds it', () => {
  const root = ws()
  assert.equal(cache(root, 'T-1', '2').status, 0)
  const r = cache(root, 'T-2', '2')
  assert.equal(r.status, 3)
  assert.match(r.stderr, /cache 2 is held by task T-1/)
  assert.equal(cache(root, 'T-2', '3').status, 0)
  assert.equal(cache(root, 'T-1', '2').status, 0, 'the holder may register it again')
})

test('server names are per task: two tasks may both run "be"', () => {
  const root = ws()
  for (const t of ['T-1', 'T-2']) assert.equal(cli('add', root, t, '--kind', 'server', '--id', 'be').status, 0)
})

test('a lock left by a crashed claimer does not block for ever', () => {
  const root = ws()
  const lock = join(root, '.pipeline', '.resources.lock')
  mkdirSync(lock, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  assert.equal(cache(root, 'T-1', '4').status, 0)
  assert.equal(existsSync(lock), false)
})

test('table: one row per task, totals, and a warning for an id held twice', () => {
  const root = ws()
  cache(root, 'T-1', '2')
  // A duplicate written before this check existed.
  mkdirSync(join(root, '.pipeline', 'T-2'), { recursive: true })
  writeFileSync(join(root, '.pipeline', 'T-2', 'resources.json'), JSON.stringify({ slug: 'T-2', prs: [], entries: [{ kind: 'cache', id: '2', release: 'x', when: 'pr-merged' }] }))
  const out = cli('list', '--table', root).stdout
  assert.match(out, /^\| Task \| PRs \| Holds \| Disk \| \/tf:clean frees it \|/)
  assert.match(out, /\| T-1 \| - \| cache 2 \| - \| no — no PR \|/)
  assert.match(out, /2 tasks · 0 freed by \/tf:clean now/)
  assert.match(out, /⚠ cache 2 is held by T-1 and T-2 at the same time/)
  assert.doesNotMatch(out, /redis-cli/, 'no commands in the table')
})
