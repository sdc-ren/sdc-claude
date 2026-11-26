// tf — generated files match their sources: what each host build writes is what the repository holds.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { PLUGIN_ROOT } from '../core/main.mjs'

import { stale } from '../build/write.mjs'
import { files as claude } from '../hosts/claude/build.mjs'
import { files as codex, manifest } from '../hosts/codex/build.mjs'

test('Claude Code: engine/task-flow.js, skills/ and agents/ are what hosts/claude/build.mjs writes', () => {
  const out = claude()
  assert.ok(out['engine/task-flow.js'].includes('export const meta = {'))
  assert.deepEqual(stale(out), [], 'run: node hosts/claude/build.mjs')
})

test('Claude Code: the Workflow script starts with its meta, as the Workflow tool reads it', () => {
  const lines = claude()['engine/task-flow.js'].split('\n')
  const first = lines.findIndex((l) => !l.startsWith('//'))
  assert.equal(lines[first], 'export const meta = {')
  assert.match(lines.at(-2), /^return await taskFlow\(args, \{ agent, parallel, phase, log, budget \}\)$/)
})

test('every shared command and role is built for Claude Code', () => {
  const out = Object.keys(claude())
  for (const n of ['build', 'qc', 'review', 'e2e', 'address-review', 'status', 'clean', 'demo', 'digest']) assert.ok(out.includes(`skills/${n}/SKILL.md`), n)
  for (const r of ['pm', 'lead', 'dev', 'tester', 'reviewer']) assert.ok(out.includes(`agents/${r}.md`), r)
})

test('Codex: .codex-plugin/plugin.json, hooks.json and the skills\' openai.yaml are what hosts/codex/build.mjs writes', () => {
  assert.deepEqual(stale(codex()), [], 'run: node hosts/codex/build.mjs')
})

test('Codex: one name and version with Claude Code, and the hook file the manifest names exists in the build', () => {
  const m = manifest()
  const cc = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(m.name, cc.name)
  assert.equal(m.version, cc.version)
  assert.match(m.version, /^\d+\.\d+\.\d+$/)
  assert.ok(codex()[m.hooks.replace(/^\.\//, '')], 'hooks.json is generated')
  for (const n of ['build', 'qc', 'review', 'e2e', 'address-review', 'status', 'clean']) assert.ok(codex()[`skills/${n}/agents/openai.yaml`], n)
})
