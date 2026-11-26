// tf — the contracts map and the contract diff, on small hand-written fixtures: one per framework and call style,
// each also checked with CRLF line ends (a Windows checkout). Repos are made in temp folders with a local origin.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { contractDiff } from '../modules/knowledge/diff.mjs'
import { contractModel, domainOf, join as joinCalls } from '../modules/knowledge/providers/contracts.mjs'
import { openRepo } from '../modules/knowledge/source.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'tf-ct-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
const write = (f, t) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t) }

function repo(dir, files, { base = 'main', crlf = false } = {}) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', base)
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false')
  for (const [f, t] of Object.entries(files)) write(join(dir, f), crlf ? t.replace(/\n/g, '\r\n') : t)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
  const bare = `${dir}.origin.git`
  execFileSync('git', ['init', '-q', '--bare', bare])
  git(dir, 'remote', 'add', 'origin', bare); git(dir, 'push', '-q', 'origin', base); git(dir, 'fetch', '-q', 'origin')
  return dir
}
const pkg = (deps) => JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, '1'])) })
const model = (dirs, knowledge = {}) => contractModel(dirs.map(([key, dir]) => ({ key, reader: openRepo(dir, 'main') })), knowledge)
const keys = (routes) => routes.map((r) => `${r.method} ${r.path}`).sort()

const FIX = {
  express: {
    'package.json': pkg(['express']),
    'tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@routes/*": ["src/routes/*"] } },\n}\n',
    'src/app.ts': "import express from 'express'\nimport api from '@routes/index'\nconst app = express()\napp.get('/health', (q, s) => s.send('ok'))\napp.use('/api', api)\n",
    'src/routes/index.ts': "import { Router } from 'express'\nimport users from './users'\nconst router = Router()\nrouter.use('/users', users)\nexport default router\n",
    'src/routes/users.ts': "import { Router } from 'express'\nconst router = Router()\n// router.get('/commented', x)\nrouter.get('/:id', requireAuth, validateUser(schema), (req, res) => res.json({}))\nrouter.route('/')\n  .get(list)\n  .post(checkAdminSignin, create)\nexport default router\n",
  },
  nest: {
    'package.json': pkg(['@nestjs/core']),
    'src/main.ts': "const app = await NestFactory.create(AppModule)\napp.setGlobalPrefix('api')\n",
    'src/orders.controller.ts': "@UseGuards(AuthGuard)\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id')\n  @Roles('admin')\n  one(@Param('id') id: string) { return {} }\n\n  @Post()\n  create(@Body() dto: CreateOrderDto) { return {} }\n}\n",
  },
  next: {
    'package.json': pkg(['next']),
    'app/api/items/[id]/route.ts': 'export async function GET() {}\nexport const DELETE = async () => {}\n',
    'app/(shop)/api/cart/route.ts': 'export function POST() {}\n',
    'pages/api/hello.ts': "export default function h(req, res) { if (req.method === 'POST') {} }\n",
  },
  nuxt: { 'package.json': pkg(['nuxt']), 'server/api/cart/index.get.ts': 'export default 1\n', 'server/api/cart/[id].delete.ts': 'export default 1\n', 'server/routes/rss.ts': 'export default 1\n' },
  fastify: { 'package.json': pkg(['fastify']), 'src/server.js': "fastify.get('/ping', async () => 'pong')\nfastify.route({ method: ['GET', 'POST'], url: '/things/:id', handler })\n" },
}

test('route readers: Express (prefixes through imports and tsconfig aliases), NestJS, Next, Nuxt, Fastify — LF and CRLF', () => {
  for (const crlf of [false, true]) {
    const ws = tmp()
    const m = model(Object.keys(FIX).map((k) => [k, repo(join(ws, k), FIX[k], { crlf })]))
    const by = (fw) => keys(m.routes.filter((r) => r.framework === fw))
    assert.deepEqual(by('Express'), ['GET /api/users', 'GET /api/users/*', 'GET /health', 'POST /api/users'], `Express crlf=${crlf}`)
    const one = m.routes.find((r) => r.path === '/api/users/*')
    assert.deepEqual(one.guards, ['requireAuth'])
    assert.deepEqual(one.validators, ['validateUser(schema)'])
    assert.equal(one.at, 'src/routes/users.ts:4', 'line numbers are the same with CRLF')
    assert.deepEqual(m.routes.find((r) => r.method === 'POST' && r.path === '/api/users').guards, ['checkAdminSignin'])
    assert.deepEqual(by('NestJS'), ['GET /api/orders/*', 'POST /api/orders'])
    const nest = m.routes.find((r) => r.framework === 'NestJS' && r.method === 'POST')
    assert.deepEqual([nest.guards, nest.validators], [['UseGuards(AuthGuard)'], ['CreateOrderDto']])
    assert.ok(m.routes.find((r) => r.framework === 'NestJS' && r.method === 'GET').guards.includes("Roles('admin')"))
    assert.deepEqual(by('Next.js'), ['DELETE /api/items/*', 'GET /api/items/*', 'POST /api/cart', 'POST /api/hello'], 'route groups are not segments')
    assert.deepEqual(by('Nuxt/Nitro'), ['ANY /rss', 'DELETE /api/cart/*', 'GET /api/cart'])
    assert.deepEqual(by('Fastify'), ['GET /ping', 'GET /things/*', 'POST /things/*'])
  }
})

const WEB = {
  'package.json': pkg(['axios', 'nuxt']),
  'app/api/users.ts': [
    "const BASE = '/api/cart'",
    'export const one = (id) => fetch(`/api/users/${id}`)',
    "export const bad = (id) => fetch('/api/users/' + id)",
    "export const order = (b) => axios.post('/api/orders', b)",
    "const api = axios.create({ baseURL: '/api' })",
    'export const drop = (id) => api.delete(`/orders/${id}`)',
    "export const stats = () => clientService<{ data: A | (B & { x: 1 }) }>({\n  path: '/api/orders/stats',\n  httpMethod: 'get',\n})",
    "export const item = () => createClient.GET('/api/items/{id}')",
    'export const cart = () => $fetch(`${BASE}/1`, { method: \'DELETE\' })',
    "export const ext = () => fetch('https://other.example/x')",
    "export const gone = () => fetch('/api/nowhere')",
    "export const routes = [{ path: '/home', component: Home }]",
    '',
  ].join('\n'),
}
const APP = {
  'pubspec.yaml': 'name: app\ndependencies:\n  dio: ^5.0.0\n  http: ^1.0.0\n',
  'lib/api.dart': "class Api {\n  Future<void> user(String id) async {\n    await dio.get('/api/users/$id');\n  }\n  Future<void> order() async {\n    await http.post(Uri.parse('$base/api/orders'));\n  }\n}\n",
}

test('call readers: fetch, axios and its clients, object wrappers with long generics, constants, Dart — and matching', () => {
  const ws = tmp()
  const m = model([['api', repo(join(ws, 'api'), FIX.express)], ['nest', repo(join(ws, 'nest'), FIX.nest)], ['next', repo(join(ws, 'next'), FIX.next)], ['web', repo(join(ws, 'web'), WEB)], ['app', repo(join(ws, 'app'), APP)]])
  const calls = m.calls.map((c) => `${c.repo} ${c.method} ${c.path}`).sort()
  assert.deepEqual(calls, [
    'app GET /api/users/*', 'app POST /api/orders',
    'web DELETE /api/cart/1', 'web DELETE /api/orders/*', 'web GET /api/items/*', 'web GET /api/nowhere', 'web GET /api/orders/stats', 'web GET /api/users/*', 'web POST /api/orders',
  ])
  assert.equal(m.coverage.find((c) => c.repo === 'web').unresolved, 1, "fetch('/api/users/' + id) is counted, not guessed")
  const j = joinCalls(m)
  const callersOf = (method, path) => (j.byRoute.get(m.routes.find((r) => r.method === method && r.path === path)) || []).map((c) => c.repo).sort()
  assert.deepEqual(callersOf('GET', '/api/users/*'), ['app', 'web'])
  assert.deepEqual(callersOf('POST', '/api/orders'), ['app', 'web'], 'a NestJS route with a global prefix')
  assert.deepEqual(callersOf('GET', '/api/orders/*'), ['web'], 'with no /orders/stats route, "stats" can be an id')
  assert.deepEqual(j.orphans.map((c) => `${c.method} ${c.path}`).sort(), ['DELETE /api/cart/1', 'DELETE /api/orders/*', 'GET /api/nowhere'])
  // With both routes, each call goes to the route of its own shape.
  const both = { ...m, routes: [...m.routes, { method: 'GET', path: '/api/orders/stats', at: 'x:1', guards: [], validators: [], repo: 'nest', framework: 'NestJS' }] }
  const j2 = joinCalls(both)
  assert.deepEqual(j2.byRoute.get(both.routes.at(-1)).map((c) => c.path), ['/api/orders/stats'])
  assert.deepEqual(j2.byRoute.get(both.routes.find((r) => r.method === 'GET' && r.path === '/api/orders/*')).map((c) => c.path), [])
  assert.equal(domainOf('/api/v1/orders/*'), 'orders')
  assert.equal(domainOf('/api/admin/users/*'), 'admin-users')
})

test('OpenAPI with a server prefix, socket events both ways, and the map files', () => {
  const ws = tmp()
  const api = repo(join(ws, 'api'), { ...FIX.express, 'package.json': pkg(['express', 'socket.io']), 'docs/openapi.yaml': 'openapi: 3.0.0\nservers:\n  - url: /api\npaths:\n  /users/{id}:\n    get:\n      summary: x\n', 'src/io.ts': "io.to(room).emit('order:updated', o)\nsocket.on('order:ack', f)\nsocket.on('connect', g)\n" })
  const web = repo(join(ws, 'web'), { 'package.json': pkg(['socket.io-client']), 'src/s.ts': "socket.on('order:updated', h)\nsocket.emit('order:ack', 1)\nfetch('/api/users/7')\n" })
  write(join(ws, '.tf', 'config.md'), '## Repos\n| key | path | base |\n|---|---|---|\n| api | `api/` | `main` |\n| web | `web/` | `main` |\n')
  const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'knowledge.mjs'), 'gen', ws], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const index = readFileSync(join(ws, 'knowledge', 'contracts', 'index.tsv'), 'utf8')
  assert.match(index, /GET\t\/api\/users\/\*\tusers\tapi\tsrc\/routes\/users\.ts:4\trequireAuth\tvalidateUser\(schema\)\tExpress\ty\t1\t/)
  assert.match(index, /GET\t\/health\thealth\tapi\t[^\t]*\t\t\tExpress\tn\t0/)
  const socket = readFileSync(join(ws, 'knowledge', 'contracts', 'socket.md'), 'utf8')
  assert.match(socket, /`order:updated` \| api \(server\)[^|]*\| web \(client\)/)
  assert.doesNotMatch(socket, /`connect`/)
  assert.match(readFileSync(join(ws, 'knowledge', 'contracts', 'README.md'), 'utf8'), /Calls matched to a route: 1 of 1/)
  assert.ok(readFileSync(join(ws, 'knowledge', 'contracts', 'by-domain', 'users.md'), 'utf8').includes('called by web'))
  void api; void web
})

test('contract diff: added, removed, changed guard, a broken caller outside the task, and the base moving on', () => {
  const ws = tmp()
  const api = repo(join(ws, 'api'), FIX.express)
  repo(join(ws, 'web'), { 'package.json': pkg(['axios']), 'src/u.ts': "export const all = () => fetch('/api/users')\n" })
  write(join(ws, '.tf', 'config.md'), '## Repos\n| key | path | base |\n|---|---|---|\n| api | `api/` | `main` |\n| web | `web/` | `main` |\n')
  // The task's worktree of api: drop GET /api/users (the list), add a route, change a guard — not committed.
  const wt = join(ws, '.worktrees', 'T-1', 'api')
  git(api, 'worktree', 'add', '-q', '-b', 'feat/t1', wt, 'origin/main')
  const users = join(wt, 'src', 'routes', 'users.ts')
  writeFileSync(users, readFileSync(users, 'utf8').replace('  .get(list)\n', '').replace('requireAuth, ', 'requireAdmin, ') + "router.patch('/:id', requireAuth, update)\n")
  // The base moves on after the task branched: a new route there is not "removed" by the task.
  write(join(api, 'src', 'routes', 'extra.ts'), "router.get('/later', h)\n")
  git(api, 'add', '-A'); git(api, 'commit', '-qm', 'later'); git(api, 'push', '-q', 'origin', 'main'); git(api, 'fetch', '-q', 'origin')
  const d = contractDiff(ws, 'T-1')
  assert.equal(d.code, 4)
  assert.deepEqual(d.removed.map((r) => `${r.method} ${r.path}`), ['GET /api/users'])
  assert.deepEqual(d.added.map((r) => `${r.method} ${r.path}`), ['PATCH /api/users/*'])
  assert.deepEqual(d.changed.map((c) => `${c.after.path} ${c.before.guards} → ${c.after.guards}`), ['/api/users/* requireAuth → requireAdmin'])
  assert.deepEqual(d.broken.map((b) => `${b.call.repo} ${b.call.at}`), ['web src/u.ts:1'], 'web is not in the task and still calls it')
  assert.ok(!d.removed.some((r) => r.path === '/later'))
  const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'knowledge.mjs'), 'diff', ws, '--task', 'T-1', '--out', '.pipeline/T-1/contract-diff.md'], { encoding: 'utf8' })
  assert.equal(r.status, 4)
  assert.match(readFileSync(join(ws, '.pipeline', 'T-1', 'contract-diff.md'), 'utf8'), /## Callers this change breaks \(1\)/)
  rmSync(wt, { recursive: true, force: true }); git(api, 'worktree', 'prune')
  assert.equal(contractDiff(ws, 'T-1').code, 0, 'no worktree: nothing changes')
})
