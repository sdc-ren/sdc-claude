// tf — the `tf` command line: every command reaches its module, and gives what the old script gives.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { COMMANDS } from '../cli/commands.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = (file, ...args) => spawnSync(process.execPath, [join(ROOT, file), ...args], { encoding: 'utf8', timeout: 60_000 })
const TF = 'cli/tf.mjs'
const CLAUDE_TF = 'hosts/claude/tf.mjs'

test('every command points at a file that exists', () => {
  for (const [name, file] of Object.entries(COMMANDS)) assert.ok(existsSync(join(ROOT, file)), `${name} → ${file}`)
})

test('every old script with a command line has a tf command', () => {
  // Not command lines: a library for flow scripts, the sandboxed canvas render, the MCP server.
  const notCli = new Set(['flow-kit', 'canvas-smoke', 'artifacts-mcp'])
  const claudeOnly = new Set(['doctor', 'metrics', 'artifacts-local'])
  const names = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4))
  for (const n of names) {
    if (notCli.has(n)) continue
    if (claudeOnly.has(n)) { assert.match(node(CLAUDE_TF).stdout, new RegExp(`^  ${n} `, 'm'), `${n} in the Claude Code tf`); continue }
    assert.ok(Object.hasOwn(COMMANDS, n), `scripts/${n}.mjs has no tf command`)
  }
})

test('tf lists its commands and its version', () => {
  const list = node(TF)
  assert.equal(list.status, 0)
  for (const n of Object.keys(COMMANDS)) assert.match(list.stdout, new RegExp(`^  ${n} `, 'm'))
  assert.doesNotMatch(list.stdout, /^ {2}doctor /m, 'Claude Code checks are the host\'s, not the shared CLI\'s')
  const v = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
  assert.equal(node(TF, '--version').stdout.trim(), v)
})

test('an unknown command fails with exit 2', () => {
  const r = node(TF, 'nope')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /no command "nope"/)
})

test('tf <command> gives what the old script gives', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tf-cli-'))
  mkdirSync(join(ws, '.claude'))
  writeFileSync(join(ws, '.claude', 'task-flow.md'), '## Repos\n| be | `backend/` | `main` |\n\n## Hard rules\n- x\n')
  const same = (args, script = `scripts/${args[0]}.mjs`) => {
    const a = node(script, ...args.slice(1)), b = node(TF, ...args)
    assert.equal(b.status, a.status, `${args.join(' ')}: exit code`)
    assert.equal(b.stdout, a.stdout, `${args.join(' ')}: output`)
  }
  same(['task', 'config', ws, '--role', 'dev'])
  same(['naming', 'check', '--kind', 'pr', 'feat: x.'])
  same(['naming', 'check', '--kind', 'commit', '--key', 'PROJ-1', 'fix(PROJ-1): y'])
  same(['sources', 'classify', 'https://x.atlassian.net/browse/PROJ-1'])
  same(['resources', 'list', '--table', ws])
  same(['cases'])
  const doctorOld = node('scripts/doctor.mjs', ws), doctorNew = node(CLAUDE_TF, 'doctor', ws)
  assert.equal(doctorNew.status, doctorOld.status)
  assert.equal(doctorNew.stdout, doctorOld.stdout)
})
