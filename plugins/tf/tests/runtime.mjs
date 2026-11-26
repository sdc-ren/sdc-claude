// tf — the process runtime (hosts that run each job as its own command line: Codex, Copilot …), the guard as a
// command hook, the background runner, and the Codex driver's command line. No agent runs here: a fake driver
// answers from the job's label, the way tests/engine.mjs mocks agents.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseJob } from '../core/guard-rules.mjs'
import { lastJson, validate } from '../engine/src/validate.mjs'
import { REPORT, DISPATCH } from '../engine/src/schemas.mjs'
import { taskFlow } from '../engine/src/flow.mjs'
import { processRuntime, rolePrompt } from '../runtime/process.mjs'
import { callsOf, decide, denyOutput } from '../runtime/guard-hook.mjs'
import { execArgs, gitDirs } from '../hosts/codex/driver.mjs'
import { hooks as codexHooks } from '../hosts/codex/build.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'tf-rt-'))
const ok = (verdict, extra = {}) => ({ status: 'done', verdict, summary: 's', ...extra })

test('validate: required, enum, nested arrays; lastJson finds the answer in prose or a fence', () => {
  assert.deepEqual(validate(ok('PASS'), REPORT), [])
  assert.deepEqual(validate({ status: 'done', verdict: 'MAYBE' }, REPORT), ['summary: required', 'verdict: one of NONE, PASS, FAIL, SHIP, NEEDS-WORK, BLOCK'])
  const d = { decision: 'dispatch', size: 'S', note: 'n', jobs: [{ id: 'J1', role: 'dev', repo: 'be', model: 'gpt', group: 1, brief: 'b', doneWhen: 'd' }] }
  assert.deepEqual(validate(d, DISPATCH), ['jobs[0].model: one of haiku, sonnet, opus'])
  assert.deepEqual(lastJson('Done.\n```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(lastJson('I did it. {"status":"done","n":{"x":[1]}} Thanks'), { status: 'done', n: { x: [1] } })
  assert.equal(lastJson('no json here'), null)
})

test('a role prompt is the role file with the plugin root written out', () => {
  const t = rolePrompt(PLUGIN, 'dev')
  assert.match(t, /You are \*\*tf:dev\*\*/)
  assert.doesNotMatch(t, /CLAUDE_PLUGIN_ROOT|^---/)
  assert.ok(t.includes(PLUGIN))
})

test('the runtime: role instructions, the job for the guard, the tier, and one more try when the answer is wrong', async () => {
  const calls = []
  const driver = {
    async run(o) { calls.push(['run', o]); return { text: 'here you go: not json', code: 0, session: 's1' } },
    async resume(o) { calls.push(['resume', o]); return { text: JSON.stringify(ok('NONE')), code: 0, session: o.session } },
  }
  const rt = processRuntime({ driver, root: '/w', plugin: PLUGIN, log: () => {} })
  const prompt = 'Job J2 · role dev lead · repo be\nTask PROJ-7 · mode build · round 1\nWorktree: /w/.worktrees/PROJ-7/be · existing PR: none\n'
  const out = await rt.agent(prompt, { agentType: 'tf:lead', model: 'opus', label: 'J2 lead:be', schema: REPORT })
  assert.deepEqual(out, ok('NONE'))
  const [kind, first] = calls[0]
  assert.equal(kind, 'run')
  assert.match(first.prompt, /You are \*\*tf:lead\*\*/)
  assert.match(first.prompt, /final message is ONLY one JSON object/)
  assert.equal(first.tier, 'large')
  assert.equal(JSON.parse(first.env.TF_JOB).role, 'dev', 'the guard hook knows this is a dev job')
  assert.equal(calls[1][0], 'resume', 'the same session is asked to fix its answer')
  assert.match(calls[1][1].prompt, /not valid/)
})

test('the engine runs end to end on the process runtime (fake agents)', async () => {
  const pm = [
    { decision: 'dispatch', size: 'S', note: 'n', scope: 'be', jobs: [
      { id: 'J1', role: 'dev', repo: 'be', model: 'sonnet', group: 1, brief: 'x', doneWhen: 'd' },
      { id: 'J2', role: 'tester', repo: 'be', model: 'sonnet', group: 2, brief: 'x', doneWhen: 'd', cases: 'C1' },
      { id: 'J3', role: 'reviewer', repo: 'be', model: 'sonnet', group: 3, brief: 'PACKAGE', doneWhen: 'd' },
    ] },
    { decision: 'close', size: 'S', note: 'n', close: { summary: 's' } },
  ]
  let turn = 0
  const labels = []
  const answer = (label) => {
    labels.push(label)
    if (/^PM t/.test(label)) return pm[turn++]
    if (label.includes('lead')) return { split: false, status: 'done', verdict: 'NONE', summary: 'did', headBefore: 'aaaaaaa1', headAfter: 'aaaaaaa1', filesChanged: ['a.ts'] }
    if (label.includes('tester')) return ok('PASS', { cases: ['C1 | PASS'] })
    if (label.includes('reviewer')) return ok('SHIP', { prUrl: 'https://x/pr/1' })
    return ok('NONE')
  }
  const driver = { async run(o) { return { text: `Done.\n${JSON.stringify(answer(o.label))}`, code: 0 } } }
  const rt = processRuntime({ driver, root: '/r', plugin: PLUGIN, log: () => {} })
  const out = await taskFlow({ root: '/r', slug: 'T-1', dir: '/r/.pipeline/T-1', scripts: '/s', config: '/c', mode: 'build', worktreePaths: { be: '/wt/be' } }, rt)
  assert.equal(out.status, 'done')
  assert.deepEqual(labels.filter((l) => !l.startsWith('PM')), ['J1 lead:be', 'J2 tester:be', 'J3 reviewer:be'])
})

const devJob = parseJob('Job J2b · role dev (member of J2) · repo be\nTask PROJ-7\n\nWorktree: /w/be\nSHARED WORKTREE: J2a edit this repo at the same time. Your files (edit nothing else): src/a.ts. Their files (do not touch): src/b.ts. Follow dev.md "Sharing the worktree".\n', 'tf:dev')

test('guard hook: Codex and Copilot inputs become the guard\'s calls, and the rules hold', () => {
  assert.match(decide(devJob, { tool_name: 'Bash', tool_input: { command: 'git commit -m "fix: y"' } }), /never runs `git commit`/)
  assert.match(decide(devJob, { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: /w/be/src/b.ts\n@@\n-x\n+y\n*** End Patch' } }), /belongs to another member/)
  assert.equal(decide(devJob, { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: /w/be/src/a.ts\n*** End Patch' } }), '')
  assert.match(decide(devJob, { toolName: 'bash', toolArgs: JSON.stringify({ command: 'gh pr merge 3' }) }), /never merges/)
  assert.match(decide(devJob, { toolName: 'edit', toolArgs: { path: 'src/b.ts' }, cwd: '/w/be' }), /belongs to another member/, 'a relative path is relative to where the agent runs')
  assert.equal(decide(null, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }), '', 'no tf job: nothing is refused')
  assert.deepEqual(callsOf({ tool_name: 'mcp__fs__read', tool_input: {} }), [], 'an MCP tool is not one the guard knows')
  assert.equal(denyOutput({ toolName: 'bash' }, 'no').permissionDecision, 'deny')
  assert.equal(denyOutput({ tool_name: 'Bash' }, 'no').hookSpecificOutput.permissionDecision, 'deny')
})

test('guard hook command: exit 2 with the reason for a tf job, silent exit 0 otherwise', () => {
  const run = (env, input) => spawnSync(process.execPath, [join(PLUGIN, 'runtime', 'guard-hook.mjs')], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8' })
  const deny = run({ TF_JOB: JSON.stringify(devJob) }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } })
  assert.equal(deny.status, 2)
  assert.match(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecisionReason, /never runs `git push`/)
  const allow = run({ TF_JOB: JSON.stringify(devJob) }, { tool_name: 'Bash', tool_input: { command: 'git status' } })
  assert.equal(allow.status, 0)
  assert.equal(allow.stdout, '')
  const other = run({ TF_JOB: '' }, { tool_name: 'Bash', tool_input: { command: 'git push' } })
  assert.equal(other.status, 0)
})

test('Codex: the job command line and the plugin hook', () => {
  const root = tmp()
  mkdirSync(join(root, 'backend', '.git'), { recursive: true })
  mkdirSync(join(root, 'notes'))
  assert.deepEqual(gitDirs(root), [join(root, 'backend', '.git')])
  const a = execArgs({ cwd: root, tier: 'small', out: '/o.txt', writable: gitDirs(root) })
  assert.equal(a[0], 'exec')
  assert.ok(a.includes('--approve-for-me') && !a.includes('-s'), 'auto-reviewed approvals; it cannot go with --sandbox')
  assert.ok(a.join(' ').includes(`--add-dir ${join(root, 'backend', '.git')}`), 'the repos\' .git is writable: setup adds worktrees, the reviewer commits')
  assert.ok(a.includes('model_reasoning_effort="low"'))
  assert.equal(a.at(-1), '-', 'the prompt comes on stdin')
  const cmd = codexHooks().hooks.PreToolUse[0].hooks[0].command
  assert.match(cmd, /^if \[ -n "\$TF_JOB" \]/, 'outside a tf job the hook exits without starting node')
  const quiet = spawnSync('sh', ['-c', cmd], { env: { PATH: process.env.PATH }, input: '{}', encoding: 'utf8' })
  assert.equal(quiet.status, 0)
})

test('the background runner: start, wait, result', async () => {
  const dir = join(tmp(), '.pipeline', 'T-1')
  mkdirSync(dir, { recursive: true })
  const root = resolve(dir, '..', '..')
  const entry = join(root, 'fake-host.mjs')
  writeFileSync(entry, `import { runnerCli } from ${JSON.stringify(pathToFileURL(join(PLUGIN, 'runtime', 'runner.mjs')).href)}
const fake = () => ({ async run() { return { text: JSON.stringify({ decision: 'escalate', size: 'S', note: 'n', escalate: 'which repo?' }), code: 0 } } })
await runnerCli(${JSON.stringify(entry)}, fake)
`)
  const args = join(dir, 'run-args.json')
  writeFileSync(args, JSON.stringify({ root, slug: 'T-1', dir, scripts: join(PLUGIN, 'scripts'), config: join(root, 'cfg.md'), mode: 'build' }))
  const started = spawnSync(process.execPath, [entry, 'start', args], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)
  assert.ok(JSON.parse(started.stdout).pid)
  let out = ''
  for (let i = 0; i < 10 && !out.includes('RESULT'); i++) out += spawnSync(process.execPath, [entry, 'wait', dir, '--timeout', '10'], { encoding: 'utf8' }).stdout
  const result = JSON.parse(out.split('RESULT ')[1])
  assert.equal(result.status, 'escalate')
  assert.match(result.question, /which repo/)
  assert.match(out, /PM t1/)
})

// ── Drivers against fake binaries (POSIX: the fakes are sh scripts) ──────────
import { chmodSync } from 'node:fs'
import { codexDriver } from '../hosts/codex/driver.mjs'
import { ALLOWED, copilotDriver, promptArgs } from '../hosts/copilot/driver.mjs'

const fakeBin = (body) => { const f = join(tmp(), 'fake'); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f }
const posixOnly = { skip: process.platform === 'win32' && 'the fake agents are sh scripts' }

test('Copilot: the job command line', () => {
  const a = promptArgs({ prompt: 'do it', tier: 'large', models: { large: 'big-model' }, extra: ['--foo'] })
  assert.deepEqual(a.slice(0, 5), ['-p', 'do it', '-s', '--no-ask-user', '--assisted-approval'])
  for (const t of ALLOWED) assert.ok(a.join(' ').includes(`--allow-tool ${t}`), t)
  assert.ok(a.join(' ').includes('--model big-model'))
  assert.equal(a.at(-1), '--foo')
  assert.ok(!promptArgs({ prompt: 'x', tier: 'small', models: {} }).includes('--model'), 'no model map: Copilot\'s default model')
})

test('Codex driver: final message from -o, session from thread.started, TF_JOB and TF_PLUGIN in the job', posixOnly, async () => {
  const bin = fakeBin(`out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t-1"}'
job=no; [ -n "$TF_JOB" ] && job=yes
printf '{"status":"done","verdict":"NONE","summary":"%s %s"}' "$TF_PLUGIN" "$job" > "$out"`)
  const r = await codexDriver({ plugin: '/p', bin }).run({ prompt: 'x', tier: 'small', cwd: tmp(), env: { TF_JOB: '{"id":"J1"}' }, label: 'J1' })
  assert.equal(r.code, 0)
  assert.equal(r.session, 't-1')
  assert.deepEqual(JSON.parse(r.text), { status: 'done', verdict: 'NONE', summary: '/p yes' })
})

test('Copilot driver through the runtime: the answer is the printed response', posixOnly, async () => {
  const bin = fakeBin(`echo 'Done, here it is:'; echo '{"status":"done","verdict":"PASS","summary":"ok"}'`)
  const rt = processRuntime({ driver: copilotDriver({ plugin: PLUGIN, bin }), root: tmp(), plugin: PLUGIN })
  const out = await rt.agent('Job J4 · role tester · repo be\nTask T-1 · mode build · round 1\n', { agentType: 'tf:tester', model: 'sonnet', label: 'J4 tester:be', schema: REPORT })
  assert.deepEqual(out, ok('PASS', { summary: 'ok' }))
})
