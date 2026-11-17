// What the scripts need from the operating system, exercised for real on the machine that runs the test:
// macOS, Linux and Windows in CI. Run: node --test tests/platform.mjs
import assert from 'node:assert/strict'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

test('doctor and the old reaper status run on this system', () => {
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

test('task.mjs: a PR link cannot smuggle a command into the shell', () => {
  const root = tmp('inject')
  const mark = join(root, 'pwned')
  // No "/" in the payload (the link pattern stops at one): the file would appear in the working directory.
  for (const input of ['https://github.com/a;touch${IFS}pwned;b/r/pull/1', 'https://github.com/o/$(touch${IFS}pwned)/pull/1', 'https://github.com/o/`touch${IFS}pwned`/pull/2']) {
    try { node('task.mjs', ['resolve', root, input], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } }) } catch {}
  }
  assert.ok(!existsSync(mark), 'no command ran')
  rmSync(root, { recursive: true, force: true })
})

test('resources.mjs: a worktree only a tool dirtied is freed; real work still keeps it', () => {
  const root = tmp('touched')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'task-flow.md'), '# config\n\n## Tool-touched files\n- `analysis_options.yaml` — flutter pub get adds exclude lines\n- `./ios/Podfile.lock`\n\n## Doctor\n- `not-a-file.txt`\n')
  const make = (slug) => {
    // A main checkout and a linked worktree of it under .worktrees/<slug>/, as setup makes them.
    const main = join(root, `${slug}-mobile`)
    const wt = join(root, '.worktrees', slug, 'mobile')
    mkdirSync(main, { recursive: true })
    mkdirSync(join(root, '.worktrees', slug), { recursive: true })
    mkdirSync(join(root, '.pipeline', slug), { recursive: true })
    const git = (args, cwd = main) => sh(`git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false ${args}`, cwd)
    git('init -q')
    git('config core.autocrlf false') // Windows runners check files out with CRLF otherwise; the test compares bytes
    writeFileSync(join(main, 'analysis_options.yaml'), 'analyzer:\n')
    writeFileSync(join(main, 'main.dart'), 'void main() {}\n')
    git('add .')
    git('commit -q -m base')
    // Pushed to a remote, so the only thing that can keep the worktree is an uncommitted change.
    const origin = join(root, `${slug}-origin.git`)
    sh(`git init -q --bare ${JSON.stringify(origin)}`, root)
    git(`remote add origin ${JSON.stringify(origin)}`)
    git('push -q origin HEAD')
    git('fetch -q origin')
    git(`worktree add -q --detach ${JSON.stringify(wt)}`)
    // No --release: for a worktree the ledger says what is held, and tf builds the command itself.
    node('resources.mjs', ['add', root, slug, '--kind', 'worktree', '--id', wt], { env })
    return wt
  }
  const held = (slug) => { const f = join(root, '.pipeline', slug, 'resources.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).entries.length : 0 }

  const tool = make('T-1')
  writeFileSync(join(tool, 'analysis_options.yaml'), 'analyzer:\n  exclude:\n    - build/**\n')
  assert.deepEqual(JSON.parse(node('resources.mjs', ['restore-touched', root, tool], { env })).restored, ['analysis_options.yaml'])
  writeFileSync(join(tool, 'analysis_options.yaml'), 'analyzer:\n  exclude:\n    - build/**\n')
  node('resources.mjs', ['release', root, 'T-1'], { env })
  assert.equal(held('T-1'), 0, 'freed: its only change was a tool-touched file')
  assert.ok(!existsSync(tool), 'the worktree itself is removed')

  const work = make('T-2')
  writeFileSync(join(work, 'analysis_options.yaml'), 'analyzer:\n  exclude:\n    - build/**\n')
  writeFileSync(join(work, 'main.dart'), 'void main() { print(1); }\n')
  try { node('resources.mjs', ['release', root, 'T-2'], { env }) } catch {}
  assert.equal(held('T-2'), 1, 'kept: main.dart is real work')
  assert.equal(readFileSync(join(work, 'main.dart'), 'utf8'), 'void main() { print(1); }\n')
  rmSync(root, { recursive: true, force: true })
})

test('resources.mjs: a worktree that is already gone counts as released', () => {
  const root = tmp('gone')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  mkdirSync(join(root, '.pipeline', 'T-1'), { recursive: true })
  const wt = join(root, '.worktrees', 'T-1', 'mobile') // never created: as after a manual `rm -rf`
  node('resources.mjs', ['add', root, 'T-1', '--kind', 'worktree', '--id', wt, '--release', 'exit 1'], { env })
  node('resources.mjs', ['release', root, 'T-1'], { env }) // throws if the release is reported as failed
  assert.ok(!existsSync(join(root, '.pipeline', 'T-1', 'resources.json')), 'nothing is held any more')
  rmSync(root, { recursive: true, force: true })
})

test('resources.mjs: a task name is never a path', () => {
  const root = tmp('slug')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  mkdirSync(join(root, 'backend'), { recursive: true })
  mkdirSync(join(root, '.pipeline'), { recursive: true })
  for (const bad of ['../backend', 'a/b', '..', '.hidden'])
    assert.throws(() => node('resources.mjs', ['archive', root, bad], { env }), /not a task name/, bad)
  assert.ok(existsSync(join(root, 'backend')), 'the folder outside .pipeline/ is still there')
  rmSync(root, { recursive: true, force: true })
})

test('resources.mjs: cleanup never deletes the digest folder, and an idle task folder still goes', () => {
  const root = tmp('digest')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  const old = new Date(Date.now() - 30 * 86_400_000)
  for (const name of ['digest', 'T-9']) {
    mkdirSync(join(root, '.pipeline', name), { recursive: true })
    const f = join(root, '.pipeline', name, 'state.json')
    writeFileSync(f, '{}')
    utimesSync(f, old, old)
    utimesSync(join(root, '.pipeline', name), old, old)
  }
  node('resources.mjs', ['prune', root, '--days', '7'], { env })
  assert.ok(existsSync(join(root, '.pipeline', 'digest', 'state.json')), 'the digests and their checkpoint are kept')
  assert.ok(!existsSync(join(root, '.pipeline', 'T-9')), 'an idle task with no PR is deleted as before')
  rmSync(root, { recursive: true, force: true })
})

test('flow-run.mjs: a flow that wrote PASS and then crashed did not pass', async () => {
  const dir = join(tmp('flow'), '.pipeline', 'T-1')
  mkdirSync(join(dir, 'flows'), { recursive: true })
  const verdict = "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nmkdirSync(process.env.EVD_DIR, { recursive: true })\nwriteFileSync(join(process.env.EVD_DIR, `${process.env.CASE}.verdict.json`), JSON.stringify({ case: process.env.CASE, status: 'PASS', runId: process.env.RUN_ID, shots: [], durationMs: 1 }))\n"
  writeFileSync(join(dir, 'flows', 'C1.mjs'), verdict + 'process.exit(1)\n')
  writeFileSync(join(dir, 'flows', 'C2.mjs'), verdict)
  try { node('flow-run.mjs', [dir]) } catch {}
  const cases = JSON.parse(readFileSync(join(dir, 'flows.json'), 'utf8')).cases
  assert.equal(cases.C1.lastResult, 'FAIL', 'PASS on disk, exit code 1')
  assert.equal(cases.C2.lastResult, 'PASS', 'a clean exit keeps its PASS')
})

test('resources.mjs: a custom kind is freed by its config recipe; a command that is not one waits for a person', () => {
  const root = tmp('recipe')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  mkdirSync(join(root, '.claude'), { recursive: true })
  mkdirSync(join(root, '.pipeline', 'T-1'), { recursive: true })
  const touch = (file) => `node -e "require('fs').writeFileSync('${file}','x')"`
  writeFileSync(join(root, '.claude', 'task-flow.md'), `# config\n\n## Provisioning\n| kind | allocate | \`--release\` | \`--stop\` |\n|---|---|---|---|\n| db | clone it | \`${touch('<file>')}\` | — |\n\n## Doctor\n`)
  const add = (id, release) => node('resources.mjs', ['add', root, 'T-1', '--kind', 'db', '--id', id, '--release', release], { env })
  add('good', touch('freed.txt'))
  add('bad', `${touch('freed2.txt')} && ${touch('pwned.txt')}`)
  const listing = node('resources.mjs', ['list', root], { env })
  assert.match(listing, /db good .*freed\.txt/, 'the command is shown')
  assert.match(listing, /db bad .*NOT a recipe/)
  try { node('resources.mjs', ['release', root, 'T-1'], { env }) } catch {}
  assert.ok(existsSync(join(root, 'freed.txt')), 'the recipe ran')
  assert.ok(!existsSync(join(root, 'pwned.txt')), 'the other command did not')
  const left = JSON.parse(readFileSync(join(root, '.pipeline', 'T-1', 'resources.json'), 'utf8')).entries
  assert.deepEqual(left.map((e) => e.id), ['bad'], 'it is kept, with the reason')
  assert.match(left[0].error, /not a db recipe/)
  node('resources.mjs', ['release', root, 'T-1', '--unlisted'], { env })
  assert.ok(existsSync(join(root, 'pwned.txt')), 'a person who has seen it can still run it')
  rmSync(root, { recursive: true, force: true })
})

test('resources.mjs: a worktree outside .worktrees/ is never removed, whatever the ledger says', () => {
  const root = tmp('wtout')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  const victim = join(root, 'backend')
  mkdirSync(victim, { recursive: true })
  writeFileSync(join(victim, 'keep.txt'), 'x')
  mkdirSync(join(root, '.pipeline', 'T-1'), { recursive: true })
  node('resources.mjs', ['add', root, 'T-1', '--kind', 'worktree', '--id', victim, '--release', `rm -rf ${JSON.stringify(victim)}`], { env })
  try { node('resources.mjs', ['release', root, 'T-1'], { env }) } catch {}
  assert.ok(existsSync(join(victim, 'keep.txt')), 'the stored command is ignored for a kind tf knows')
  rmSync(root, { recursive: true, force: true })
})

test('resources.mjs: releasing a port leaves a listener that is not this task\'s', { skip: P.IS_WIN && 'Windows cannot tell which folder a process runs from' }, async () => {
  const root = tmp('port')
  const env = { ...process.env, HOME: root, USERPROFILE: root }
  const wt = join(root, '.worktrees', 'T-1', 'be')
  const elsewhere = join(root, 'someone-else')
  for (const d of [wt, elsewhere, join(root, '.pipeline', 'T-1')]) mkdirSync(d, { recursive: true })
  const listen = "const s = require('http').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port))"
  const start = (cwd) => new Promise((res) => { const c = track(spawn(process.execPath, ['-e', listen], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })); c.stdout.once('data', (b) => res({ pid: c.pid, port: Number(String(b).trim()) })) })
  const theirs = await start(elsewhere)
  const mine = await start(wt)
  for (const s of [theirs, mine]) node('resources.mjs', ['add', root, 'T-1', '--kind', 'port', '--id', String(s.port)], { env })
  node('resources.mjs', ['release', root, 'T-1'], { env })
  assert.ok(await until(() => !P.alive(mine.pid)), 'the task\'s own server is stopped')
  assert.ok(P.alive(theirs.pid), 'a process running from another folder is left alone')
  rmSync(root, { recursive: true, force: true })
})

test('pool.mjs and fastdeps.mjs refuse names that leave their folder', () => {
  const root = tmp('pool')
  const repo = join(root, 'be')
  mkdirSync(repo, { recursive: true })
  const j = (script, args) => { try { return JSON.parse(node(script, args)) } catch (e) { return JSON.parse(String(e.stdout)) } }
  assert.match(j('pool.mjs', ['fill', root, '../../x', repo]).reason, /bad pool key/)
  assert.match(j('pool.mjs', ['fill', root, 'be', repo, '--base', '--upload-pack=x']).reason, /bad --base/)
  assert.match(j('pool.mjs', ['fill', root, 'be', repo, '--lock', 'package-lock.json', '--dirs', '../../victim']).reason, /not a path inside/)
  rmSync(root, { recursive: true, force: true })
})
