// What the scripts need from the operating system, exercised for real on the machine that runs the test:
// macOS, Linux and Windows in CI. Run: node --test tests/platform.mjs
import assert from 'node:assert/strict'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as P from '../scripts/platform.mjs'

const S = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
afterEach(() => reap())
const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `tf-${name}-`)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200) } return false }
const node = (script, args, opts = {}) => execFileSync(process.execPath, [join(S, script), ...args], { stdio: 'pipe', ...opts }).toString()
// Every process a test starts is stopped when the test ends, pass or fail — a leftover child keeps the run open.
const started = []
const track = (child) => { started.push(child.pid); return child }
const reap = () => { for (const pid of started.splice(0)) { try { P.killGroup(pid) } catch {} try { P.killTree(pid) } catch {} } }
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', shell: P.SH, windowsHide: true }).toString().trim()

test('paths compare the same whichever separator they were written with', () => {
  assert.equal(P.base('/a/b/c/'), 'c')
  assert.equal(P.base('C:\\work\\app\\'), 'app')
  assert.equal(P.base('backend/'), 'backend')
  assert.equal(P.rootOfTask('/r/ws/.pipeline/T-1'), '/r/ws')
  assert.equal(P.rootOfTask('C:\\ws\\.pipeline\\_archive\\T-1'), 'C:\\ws')
  const dir = tmp('under')
  assert.ok(P.under(join(dir, 'a', 'b'), dir))
  assert.ok(P.under(dir, dir))
  assert.ok(!P.under(`${dir}-other`, dir))
  assert.ok(!P.under('', dir))
  rmSync(dir, { recursive: true, force: true })
})

test('a workspace finds its Claude Code transcript folder', () => {
  assert.equal(P.projectDirName('/Users/me/work/app').replace(/^[A-Za-z]--/, '-'), '-Users-me-work-app')
  assert.equal('C:\\Users\\me\\work\\app'.replace(/[^A-Za-z0-9]/g, '-'), 'C--Users-me-work-app')
  const m = P.projectMatch('-Users-me-work-app')
  assert.ok(m('-Users-me-work-app') && m('-Users-me-work-app-backend-src'))
  assert.ok(!m('-Users-me-work-application') && !m('-Users-me-work'))
  const long = `-${'x'.repeat(240)}`
  assert.ok(P.projectMatch(long)(`${long.slice(0, 200)}-1a2b3c`))
  const old = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'elsewhere')
  assert.equal(P.claudeDir(), join(tmpdir(), 'elsewhere'))
  if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old
})

test('programs are found on PATH and commands run through the shell', () => {
  assert.ok(P.which('node'), 'node on PATH')
  assert.ok(P.which('git'), 'git on PATH')
  assert.equal(P.which('surely-not-a-program-xyz'), '')
  assert.ok(P.info().shellOk, `a POSIX shell (Git Bash on Windows): ${P.info().shell}`)
  const dir = tmp('sh path')
  writeFileSync(join(dir, 'hello world.txt'), 'hi')
  // JSON-quoted paths (spaces, backslashes) and POSIX one-liners both survive the shell.
  assert.equal(sh(`cat ${JSON.stringify(join(dir, 'hello world.txt'))} 2>/dev/null || true`), 'hi')
  assert.equal(sh(`${P.nodeCmd(join(S, 'platform.mjs'), 'info')} | ${P.nodeCmd(join(S, 'platform.mjs'), 'bad')} 2>/dev/null || echo fallback`), 'fallback')
  assert.equal(JSON.parse(sh(P.nodeCmd(join(S, 'platform.mjs'), 'info'))).os, P.OS)
  rmSync(dir, { recursive: true, force: true })
})

test('a listening port is traced to its process, and freed', async () => {
  const dir = tmp('port')
  const script = join(dir, 'srv.mjs')
  writeFileSync(script, "import { createServer } from 'node:http'\nconst s = createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => console.log(s.address().port))\n")
  const child = track(spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] }))
  const port = await new Promise((res) => child.stdout.once('data', (d) => res(Number(String(d).trim()))))
  assert.ok(await until(() => P.pidsOnPort(port).length > 0), `port ${port} seen as busy`)
  assert.ok(P.pidsOnPort(port).includes(String(child.pid)), 'the listening pid is ours')
  if (!P.IS_WIN) assert.ok(P.under(P.cwdOf(child.pid), process.cwd()), 'cwd of the process')
  sh(P.freePortCmd(port))
  assert.ok(await until(() => P.pidsOnPort(port).length === 0), 'port freed')
  assert.ok(await until(() => !P.alive(child.pid)), 'process gone')
  rmSync(dir, { recursive: true, force: true })
})

test('a detached shell command is a group that can be found and stopped with its children', async () => {
  const dir = tmp('group')
  const mark = join(dir, 'started')
  writeFileSync(join(dir, 'wait.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(mark)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
  // The way serve.mjs starts a dev server: a shell line that starts the real program.
  const child = track(P.spawnShell(`${P.nodeCmd(join(dir, 'wait.mjs'))} && echo done`, { cwd: dir, stdio: 'ignore' }))
  child.unref()
  assert.ok(await until(() => existsSync(mark)), 'the program started')
  const inner = Number(readFileSync(mark, 'utf8'))
  assert.ok(P.groupMembers(child.pid).length > 0, 'group is alive')
  P.killGroup(child.pid)
  assert.ok(await until(() => !P.alive(inner)), 'the program inside the shell was stopped')
  assert.ok(await until(() => P.groupMembers(child.pid).length === 0), 'group is gone')
  rmSync(dir, { recursive: true, force: true })
})

test('a dependency folder is copied with its nested files', () => {
  const dir = tmp('clone')
  mkdirSync(join(dir, 'node_modules', 'pkg', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'lib', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(dir, 'wt'))
  const how = P.cloneDir(join(dir, 'node_modules'), join(dir, 'wt', 'node_modules'))
  assert.ok(['clone', 'reflink-or-copy', 'copy'].includes(how))
  assert.equal(readFileSync(join(dir, 'wt', 'node_modules', 'pkg', 'lib', 'index.js'), 'utf8'), 'module.exports = 1\n')
  assert.equal(P.tail(join(dir, 'node_modules', 'pkg', 'lib', 'index.js'), 5), 'module.exports = 1')
  assert.equal(P.tail(join(dir, 'missing.log')), '')
  rmSync(dir, { recursive: true, force: true })
})

test('task.mjs: commits a dev job made are undone, the changes stay', () => {
  const wt = tmp('repo')
  const git = (args) => sh(`git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false ${args}`, wt)
  git('init -q')
  git('commit -q --allow-empty -m base')
  const before = JSON.parse(node('task.mjs', ['head', wt])).head
  writeFileSync(join(wt, 'a.txt'), 'a')
  git('add a.txt')
  git('commit -q -m one')
  assert.equal(JSON.parse(node('task.mjs', ['uncommit', wt, before])).undone, 1)
  assert.equal(JSON.parse(node('task.mjs', ['head', wt])).head, before)
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'a')
  assert.throws(() => node('task.mjs', ['uncommit', wt, 'deadbeef']))
  rmSync(wt, { recursive: true, force: true })
})

test('resources.mjs: a registered resource is released by its command at run end', async () => {
  const root = tmp('ws')
  mkdirSync(join(root, '.pipeline', 'T-1'), { recursive: true })
  const child = track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  node('resources.mjs', ['add', root, 'T-1', '--kind', 'browser', '--id', String(child.pid), '--release', P.killCmd(child.pid), '--when', 'run-end'], { env })
  node('resources.mjs', ['add', root, 'T-1', '--kind', 'port', '--id', '3999', '--release', 'echo freed 2>/dev/null || true'], { env })
  assert.match(node('resources.mjs', ['taken', root, 'port'], { env }), /3999/)
  node('resources.mjs', ['end-run', root, 'T-1'], { env })
  assert.ok(await until(() => !P.alive(child.pid)), 'the run-end resource was stopped')
  const left = JSON.parse(readFileSync(join(root, '.pipeline', 'T-1', 'resources.json'), 'utf8')).entries
  assert.deepEqual(left.map((e) => e.kind), ['port'], 'the pr-merged resource is kept')
  rmSync(root, { recursive: true, force: true })
})

test('serve.mjs: starts a configured server on the task port, reuses it, stops it', async (t) => {
  const root = tmp('serve')
  const wt = join(root, '.worktrees', 'T-1', 'backend')
  mkdirSync(wt, { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  mkdirSync(join(root, '.pipeline', 'T-1'), { recursive: true })
  writeFileSync(join(wt, 'app.mjs'), "import { createServer } from 'node:http'\ncreateServer((q, r) => r.end(process.env.GREETING)).listen(Number(process.env.PORT), '127.0.0.1')\n")
  const port = await new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
  const cfg = { be: { dir: 'backend', port: true, cmd: `${P.nodeCmd('app.mjs')}`, timeout: 40, env: { PORT: '{port}', GREETING: 'hello from {slug}' }, health: 'http://127.0.0.1:{port}/' } }
  writeFileSync(join(root, '.claude', 'task-flow.md'), `# config\n\n## Servers\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`)
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  node('resources.mjs', ['add', root, 'T-1', '--kind', 'port', '--id', String(port), '--release', P.freePortCmd(port)], { env })
  t.after(() => { try { node('serve.mjs', ['stop', root, 'T-1'], { env }) } catch {} for (const pid of P.pidsOnPort(port)) if (Number(pid)) P.killTree(pid) })
  let startedOut
  try { startedOut = node('serve.mjs', ['start', root, 'T-1'], { env }) } catch (e) { startedOut = String(e.stdout) }
  const started = JSON.parse(startedOut.trim().split('\n').pop())
  assert.equal(started.status, 'started', JSON.stringify(started))
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hello from T-1')
  const again = JSON.parse(node('serve.mjs', ['start', root, 'T-1'], { env }).trim().split('\n').pop())
  assert.equal(again.status, 'running', JSON.stringify(again))
  const stopped = JSON.parse(node('serve.mjs', ['stop', root, 'T-1'], { env }).trim().split('\n').pop())
  assert.equal(stopped.status, 'stopped')
  assert.ok(await until(() => P.pidsOnPort(port).length === 0), 'the server no longer listens')
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('doctor and the reaper status run on this system', () => {
  const root = tmp('doctor')
  // No workspace config in an empty folder: doctor reports that and exits 1 — its table is what we read.
  let out
  try { out = execFileSync(process.execPath, [join(S, 'doctor.mjs'), root], { stdio: 'pipe' }).toString() } catch (e) { out = String(e.stdout) }
  assert.match(out, new RegExp(`system: ${P.OS}`))
  let status
  try { status = node('reaper.mjs', ['status']) } catch (e) { status = String(e.stdout) }
  assert.match(status, /installed/)
  rmSync(root, { recursive: true, force: true })
})
