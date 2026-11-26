// tf — workspace detection, knowledge maps (repos, ledger), the stale check, and /tf:init's four cases. Every
// workspace here is made up in a temp folder: one repo, several repos, a monorepo, one with its own generator.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { knowledgeOf, repoRows } from '../core/config.mjs'
import { detect } from '../modules/knowledge/detect.mjs'
import { check, generate } from '../modules/knowledge/gen.mjs'
import { apply, caseOf, draft, lineDiff, withKnowledge } from '../modules/knowledge/init.mjs'
import { parseNotes } from '../modules/knowledge/providers/ledger.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'tf-kn-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
const write = (f, text) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text) }

// A git repo with a commit and an origin/<base> ref pointing at it (no network: the remote is a local bare repo).
function repo(dir, files, base = 'main') {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', base)
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  for (const [f, t] of Object.entries(files)) write(join(dir, f), t)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
  const bare = `${dir}.origin.git`
  execFileSync('git', ['init', '-q', '--bare', bare])
  git(dir, 'remote', 'add', 'origin', bare); git(dir, 'push', '-q', 'origin', base); git(dir, 'fetch', '-q', 'origin')
  return dir
}
const nodeApp = (extra = {}) => ({
  'package.json': JSON.stringify({ scripts: { dev: 'next dev -p 3100', test: 'vitest' }, dependencies: { next: '14' }, devDependencies: { '@playwright/test': '1' }, ...extra }),
  'package-lock.json': '{}', '.env.example': 'PORT=3100\nREDIS_PORT=6379\nAPI_URL=x\n', 'README.md': '# app\n',
  'src/modules/cart/a.ts': 'x', 'src/modules/order/b.ts': 'x', 'src/modules/user/c.ts': 'x',
})

test('detect: one repo at the root, several repos, a monorepo; ports of the app only', () => {
  const one = repo(join(tmp(), 'shop'), nodeApp())
  const p1 = detect(one)
  assert.equal(p1.shape, 'single repo')
  assert.equal(p1.repos[0].path, './')
  assert.deepEqual(p1.repos[0].stack.slice(0, 1), ['Next.js'])
  assert.equal(p1.repos[0].base, 'main')
  assert.deepEqual(p1.repos[0].ports, ['3100 (.env.example PORT)', '3100 (scripts.dev)'], 'REDIS_PORT is not the app\'s port')
  assert.deepEqual(p1.repos[0].domains, { dir: 'src/modules', names: ['cart', 'order', 'user'] })

  const ws = tmp()
  repo(join(ws, 'api'), { 'package.json': JSON.stringify({ dependencies: { express: '4', sequelize: '6' } }), 'yarn.lock': '' }, 'develop')
  repo(join(ws, 'app'), { 'pubspec.yaml': 'name: app', 'pubspec.lock': '' })
  const p2 = detect(ws)
  assert.equal(p2.shape, 'several repos')
  assert.deepEqual(p2.repos.map((r) => `${r.key}:${r.path}:${r.base}:${r.packageManager}`), ['api:api/:develop:yarn', 'app:app/:main:flutter'])

  const mono = repo(join(tmp(), 'mono'), { 'package.json': JSON.stringify({ workspaces: ['packages/*'] }), 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': '' })
  assert.equal(detect(mono).repos[0].monorepo, 'package.json workspaces')
})

test('ledger notes: tables by header (English or Vietnamese, "A (…)" matches A) and lists of lines', () => {
  const f = parseNotes('findings', '# F\n\n| ID | Ngày | Repo | Mức | Mô tả | Trạng thái | Nguồn |\n|---|---|---|---|---|---|---|\n| F-1 | 2026-01-02 | api | HIGH | cart total wrong | open | t1 |\n| F-2 | 2026-01-03 | app | LOW | icon | fixed | t2 |\n')
  assert.deepEqual(f.map((e) => [e.id, e.repoRaw, e.status, e.line]), [['F-1', 'api', 'open', 5], ['F-2', 'app', 'fixed', 6]])
  const d = parseNotes('decisions', '| ID | Q | A (đã chốt) | Ngày | Task |\n|---|---|---|---|---|\n| D-1 | retry orders? | no | 2026-01-01 | t |\n')
  assert.equal(d[0].summary, 'retry orders? → no')
  const l = parseNotes('review-lessons', '# L\n\n- [M4] [api] never return 500 for a missing order\n  - a sub-point is not an entry\n- plain rule\n')
  assert.deepEqual(l.map((e) => [e.kind, e.repoRaw, e.summary]), [['lesson', 'M4 api', 'never return 500 for a missing order'], ['lesson', '', 'plain rule']])
})

test('maps: repos and ledger written, pipeline/ untouched, stale when a repo or a note changes', () => {
  const ws = tmp()
  const api = repo(join(ws, 'api'), nodeApp())
  repo(join(ws, 'web'), { 'package.json': '{"dependencies":{"nuxt":"3"}}', 'pnpm-lock.yaml': '' })
  write(join(ws, 'knowledge', 'pipeline', 'findings.md'), '| ID | Repo | Summary | Status |\n|---|---|---|---|\n| F-1 | api | the cart total is wrong | open |\n| F-2 | web | old | fixed |\n')
  const notes = readFileSync(join(ws, 'knowledge', 'pipeline', 'findings.md'), 'utf8')
  assert.deepEqual(check(ws).stale.map((s) => s.map), ['repos', 'contracts', 'ledger'])
  const g = generate(ws)
  assert.ok(g.written.includes('repos/api.md') && g.written.includes('repos/web.md') && g.written.includes('ledger/by-repo/api.md'))
  assert.equal(readFileSync(join(ws, 'knowledge', 'pipeline', 'findings.md'), 'utf8'), notes, 'hand-kept notes untouched')
  assert.match(readFileSync(join(ws, 'knowledge', 'ledger', 'by-repo', 'api.md'), 'utf8'), /F-1.*cart total/)
  assert.doesNotMatch(readFileSync(join(ws, 'knowledge', 'ledger', 'by-repo', 'web.md'), 'utf8'), /F-2/, 'closed findings are left out of the slices')
  assert.match(readFileSync(join(ws, 'knowledge', 'ledger', 'topics', 'cart.md'), 'utf8'), /F-1/, 'topics from the repos\' domain folders')
  assert.match(readFileSync(join(ws, 'knowledge', 'README.md'), 'utf8'), /Which map answers which question/)
  assert.deepEqual(check(ws).stale, [])
  // A new commit on the base branch makes repos stale; a new note makes ledger stale.
  write(join(api, 'src', 'modules', 'pay', 'p.ts'), 'x'); git(api, 'add', '-A'); git(api, 'commit', '-qm', 'pay'); git(api, 'push', '-q', 'origin', 'main'); git(api, 'fetch', '-q', 'origin')
  write(join(ws, 'knowledge', 'pipeline', 'decisions.md'), '| ID | Q | A |\n|---|---|---|\n| D-1 | x | y |\n')
  assert.deepEqual(check(ws).stale.map((s) => s.map), ['repos', 'contracts', 'ledger'])
  generate(ws, { only: ['ledger'] })
  assert.deepEqual(check(ws).stale.map((s) => s.map), ['repos', 'contracts'])
})

test('maps: a knowledge/ folder tf did not write is refused', () => {
  const ws = tmp()
  repo(join(ws, 'api'), nodeApp())
  write(join(ws, 'knowledge', 'notes-of-someone.md'), 'mine')
  assert.throws(() => generate(ws), /holds files tf did not write/)
})

test('config: repo rows, Knowledge lines, and adding tf\'s lines keeps every line a person wrote', () => {
  const cfg = '# c\n\n## Repos\n| key | path | base |\n|---|---|---|\n| be | `backend/` | `develop` (never x) |\n\n## Knowledge (old heading)\nRead the slices, not the whole notes.\n\n## Flows (e2e)\nx\n'
  assert.deepEqual(repoRows(cfg), [{ key: 'be', path: 'backend/', base: 'develop' }])
  const next = withKnowledge(cfg, ['- Entry: `knowledge/README.md`', '- Check: `node gen.mjs --check` ⚠ confirm'])
  assert.deepEqual(knowledgeOf(next), { entry: 'knowledge/README.md', check: 'node gen.mjs --check' })
  assert.deepEqual(lineDiff(cfg, next), ['+ 9: - Entry: `knowledge/README.md`', '+ 10: - Check: `node gen.mjs --check` ⚠ confirm'])
  assert.equal(withKnowledge(next, ['- Entry: `other/README.md`']), next, 'a line already there is not added again')
  const none = withKnowledge('# c\n\n## Repos\nx\n\n## Flows (e2e)\ny\n', ['- Entry: `knowledge/README.md`'])
  assert.match(none, /## Knowledge[^\n]*\n- Entry: `knowledge\/README.md`\n\n## Flows/, 'a missing section goes before Flows')
})

test('init case A, one repo: a new config, local excludes, notes and maps; a second run changes nothing', () => {
  const ws = repo(join(tmp(), 'shop'), nodeApp())
  assert.equal(caseOf(detect(ws)), 'A')
  const d = draft(ws)
  assert.equal(d.path, '.tf/config.md')
  assert.match(d.text, /\| shop \| `\.\/` \| `main` \| npm \|/)
  assert.match(d.text, /"cmd": "npm run dev"/)
  assert.match(d.text, /- Playwright package: `package\.json`/)
  const r = apply(ws)
  assert.ok(existsSync(join(ws, '.tf', 'config.md')))
  assert.ok(existsSync(join(ws, 'knowledge', 'pipeline', 'findings.md')) && existsSync(join(ws, 'knowledge', 'repos', 'shop.md')))
  const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')
  for (const x of ['/.worktrees/', '/.pipeline/', '/knowledge/*', '!/knowledge/pipeline/']) assert.ok(exclude.includes(x), x)
  assert.equal(git(ws, 'status', '--porcelain'), '?? knowledge/', 'only the hand-kept notes show; the user chooses to commit them')
  assert.ok(r.gaps.some((g) => g.kind === 'index' || g.kind === 'tool'), 'no index yet: either the tool or the index is a gap, depending on the machine')
  assert.equal(draft(ws).changed, false, 'init twice: nothing more to write')
})

test('init case B: a config and the workspace\'s own generator — only the Knowledge lines are added', () => {
  const ws = tmp()
  repo(join(ws, 'be'), nodeApp())
  write(join(ws, '.claude', 'task-flow.md'), '# cfg\n\n## Repos\n| key | path | base |\n|---|---|---|\n| be | `be/` | `main` |\n\n## Knowledge\nOur own notes line.\n\n## Hard rules\n- never X\n')
  write(join(ws, 'scripts', 'knowledge', 'gen.mjs'), '// own generator')
  write(join(ws, 'knowledge', 'README.md'), '# Ours\n\n- `node scripts/knowledge/gen.mjs --check`\n- `node scripts/knowledge/diff.mjs --task <SLUG>`\n')
  write(join(ws, 'knowledge', 'pipeline', 'findings.md'), '| ID |\n|---|\n')
  const before = readFileSync(join(ws, '.claude', 'task-flow.md'), 'utf8')
  const d = draft(ws)
  assert.equal(d.case, 'B')
  assert.ok(d.diff.every((l) => l.startsWith('+ ')), 'nothing removed')
  assert.match(d.text, /- Generate: `node scripts\/knowledge\/gen\.mjs` ⚠ confirm/)
  assert.match(d.text, /- Check: `node scripts\/knowledge\/gen\.mjs --check` ⚠ confirm/)
  assert.match(d.text, /- Diff: `node scripts\/knowledge\/diff\.mjs --task <SLUG>` ⚠ confirm/)
  apply(ws)
  const after = readFileSync(join(ws, '.claude', 'task-flow.md'), 'utf8')
  assert.ok(after.includes('Our own notes line.') && after.includes('- never X'))
  assert.doesNotMatch(after, /⚠ confirm/, 'applying confirms the commands')
  assert.ok(!existsSync(join(ws, 'knowledge', 'manifest.json')), 'tf does not generate over the workspace\'s own maps')
  // 6 lines, plus "Code index" when this machine has a code-index tool.
  assert.equal(after.split('\n').length - before.split('\n').length, d.diff.length)
  assert.ok(d.diff.length === 6 || d.diff.length === 7)
})

test('init case C and D, and --from takes only the shared sections', () => {
  const c = tmp()
  repo(join(c, 'api'), nodeApp())
  write(join(c, '.claude', 'task-flow.md'), '# cfg\n\n## Repos\n| key | path | base |\n|---|---|---|\n| api | `api/` | `main` |\n')
  assert.equal(caseOf(detect(c)), 'C')
  apply(c)
  assert.match(readFileSync(join(c, '.claude', 'task-flow.md'), 'utf8'), /## Knowledge[^\n]*\n- Entry: `knowledge\/README\.md`/)
  assert.ok(existsSync(join(c, 'knowledge', 'repos', 'api.md')))

  const dd = tmp()
  repo(join(dd, 'api'), nodeApp())
  write(join(dd, 'knowledge', 'README.md'), '# notes\n')
  assert.equal(caseOf(detect(dd)), 'D')
  const other = join(tmp(), 'other.md')
  write(other, '# other\n\n## Language\n- Report language: vi\n\n## Repos\n| zz | `secret-repo/` | `main` |\n\n## Hard rules\n- never touch prod\n')
  const d = draft(dd, { from: other })
  assert.match(d.text, /- Report language: vi/)
  assert.match(d.text, /- never touch prod/)
  assert.doesNotMatch(d.text, /secret-repo|other\.md/, 'nothing but the shared sections, and not the file\'s path')
  assert.match(d.text, /\.tf\/knowledge\/README\.md/, 'a knowledge/ folder tf did not write is left alone')
})

test('tf init and tf knowledge are commands', () => {
  const ws = repo(join(tmp(), 'shop'), nodeApp())
  const r = spawnSync(process.execPath, [join(PLUGIN, 'cli', 'tf.mjs'), 'init', 'report', ws], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).case, 'A')
  const c = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'knowledge.mjs'), 'check', ws], { encoding: 'utf8' })
  assert.equal(c.status, 1)
  assert.match(c.stdout, /stale: repos — never generated/)
})
