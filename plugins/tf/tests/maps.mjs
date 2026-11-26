// tf — the code maps of phase 2b (runtime, states, erd, e2e, features), on small hand-written fixtures, each also
// checked with CRLF line ends (a Windows checkout). Repos are made in temp folders with a local origin.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findEnums, findWrites } from '../modules/knowledge/frameworks/enums.mjs'
import { findModels, usersOf } from '../modules/knowledge/frameworks/models.mjs'
import runtimeReader from '../modules/knowledge/frameworks/runtime.mjs'
import { check } from '../modules/knowledge/gen.mjs'
import { codeSelectors, flowSelectors } from '../modules/knowledge/providers/e2e.mjs'
import { findTagged, tagsOf } from '../modules/knowledge/providers/features.mjs'
import { isSource } from '../modules/knowledge/scan.mjs'
import { openRepo } from '../modules/knowledge/source.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'tf-maps-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
const write = (f, t) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t) }
const pkg = (deps) => JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, '1'])) })

function repo(dir, files, { crlf = false } = {}) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false')
  for (const [f, t] of Object.entries(files)) write(join(dir, f), crlf ? t.replace(/\n/g, '\r\n') : t)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
  const bare = `${dir}.origin.git`
  execFileSync('git', ['init', '-q', '--bare', bare])
  git(dir, 'remote', 'add', 'origin', bare); git(dir, 'push', '-q', 'origin', 'main'); git(dir, 'fetch', '-q', 'origin')
  return dir
}

const API = {
  'package.json': pkg(['express', 'bullmq', 'node-cron', 'ioredis', 'sequelize', 'socket.io']),
  'src/queues/names.ts': "export const QUEUE_NAMES = {\n  MAIL: 'mail-send',\n}\n",
  'src/queues/mail.queue.ts': "import { QUEUE_NAMES } from './names'\nexport const mailQueue = new Queue<MailJob>(QUEUE_NAMES.MAIL, { connection })\nexport const getMailQueue = () => mailQueue\nawait getMailQueue().add('welcome', data)\n",
  'src/queues/mail.processor.ts': "new Worker(\n  QUEUE_NAMES.MAIL,\n  async (job) => send(job),\n)\n",
  'src/worker.ts': "class Jobs {\n  start() {\n    // cron.schedule('* * * * *', old)\n    cron.schedule('0 3 * * *', () => cleanup())\n  }\n}\n",
  'src/events.ts': "const CHANNEL = 'app:room-changed'\nredis.publish(CHANNEL, '1')\nsubscriber\n  .subscribe(CHANNEL)\nthis.eventBus.emit('order.paid', o)\n",
  'src/routes/pay.ts': "import { Router } from 'express'\nconst router = Router()\nrouter.post('/payments/ipn', handleIpn)\nrouter.get('/payments/gateway-return', back)\nrouter.get('/payments/:id', requireAuth, one)\nexport default router\n",
  'src/app.ts': "import express from 'express'\nimport pay from './routes/pay'\nconst app = express()\napp.use('/api', pay)\nio.to(roomOf(x)).emit(EVENTS.ORDER, o)\n",
  'src/consts.ts': "export const EVENTS = {\n  ORDER: 'order:updated',\n}\n",
  // states
  'src/enums/order-status.ts': "export enum OrderStatus {\n  PENDING = 'pending',\n  PAID = 'paid',\n}\nexport enum Color { RED = 'red' }\n",
  'src/services/order.service.ts': "/**\n * @screen Orders  @api list-orders\n * @role admin\n */\nexport async function pay(o) {\n  o.status = OrderStatus.PAID\n  if (o.status === OrderStatus.PENDING) return\n  await Order.update({ status: OrderStatus.PAID })\n  return User.findByPk(o.userId)\n}\n",
  // erd (Sequelize)
  'src/models/order.ts': "class Order extends Model {}\nOrder.init({\n  id: { type: DataTypes.INTEGER, primaryKey: true },\n  status: { type: DataTypes.ENUM('pending', 'paid') },\n  user_id: { type: DataTypes.INTEGER, references: { model: 'User', key: 'id' } },\n}, { sequelize, tableName: 'orders' })\n",
  'src/models/user.ts': "class User extends Model {}\nUser.init({\n  id: { type: DataTypes.INTEGER },\n  email: { type: DataTypes.STRING },\n}, { sequelize, tableName: 'users' })\nUser.hasMany(Order, { foreignKey: 'user_id' })\n",
  'src/services/report.service.ts': "export const count = () => Order.count()\n",
}
const PRISMA = { 'package.json': pkg(['@prisma/client']), 'prisma/schema.prisma': 'model Post {\n  id    Int    @id\n  title String\n  author   User @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n\nenum PostState {\n  DRAFT\n  LIVE\n}\n' }
const WEB = {
  'package.json': pkg(['vue']),
  'app/components/row.vue': '<template>\n  <tr :data-testid="`order-row-${o.id}`" />\n  <button data-testid="order-pay">Pay</button>\n  <span :data-testid="\'order-badge-\' + o.status" />\n</template>\n',
}
const APP = {
  'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
  'lib/order.dart': "enum OrderState { open, closed; }\nWidget b() => Semantics(identifier: 'order_pay_button', child: Text('x'))\nfinal k = Key('order_list')\n",
}

test('runtime reader: cron, queue and worker named through constants, jobs, pub/sub, events — LF and CRLF', () => {
  for (const crlf of [false, true]) {
    const r = openRepo(repo(join(tmp(), 'api'), API, { crlf }), 'main')
    const got = runtimeReader.extract(r, { isSource }).map((i) => `${i.kind} ${i.name}`).sort()
    assert.deepEqual(got, ['cron Jobs', 'event order.paid', 'job welcome', 'pubsub app:room-changed', 'pubsub app:room-changed', 'queue mail-send', 'worker mail-send'], `crlf=${crlf}`)
    const cron = runtimeReader.extract(r, { isSource }).find((i) => i.kind === 'cron')
    assert.equal(cron.detail, '0 3 * * *')
    assert.equal(cron.at, 'src/worker.ts:4')
  }
})

test('state enums and where each value is written; models, relations and their users — LF and CRLF', () => {
  for (const crlf of [false, true]) {
    const r = openRepo(repo(join(tmp(), 'api'), API, { crlf }), 'main')
    const enums = findEnums(r, /status|state/i)
    assert.deepEqual(enums.map((e) => `${e.kind} ${e.name} ${e.values.map((v) => v.value).join(',')}`).sort(), ['column Order.status pending,paid', 'enum OrderStatus pending,paid'])
    const w = findWrites(r, enums)
    assert.deepEqual(w['OrderStatus.PAID'], ['src/services/order.service.ts:6', 'src/services/order.service.ts:8'])
    assert.equal((w['OrderStatus.PENDING'] || []).length, 0, 'a comparison is not a write')
    const models = findModels(r)
    const order = models.find((m) => m.name === 'Order')
    assert.equal(order.table, 'orders')
    assert.deepEqual(order.cols.map((c) => c.name), ['id', 'status', 'user_id'])
    assert.deepEqual(order.rels, [{ kind: 'belongsTo', target: 'User', key: 'user_id' }])
    assert.deepEqual(models.find((m) => m.name === 'User').rels, [{ kind: 'hasMany', target: 'Order', key: 'user_id' }])
    const users = usersOf(r, models)
    assert.deepEqual(users.Order.sort(), ['src/services/order.service.ts', 'src/services/report.service.ts'])
    assert.deepEqual(users.User, ['src/services/order.service.ts'])
  }
  const p = openRepo(repo(join(tmp(), 'blog'), PRISMA), 'main')
  assert.deepEqual(findModels(p).map((m) => `${m.name} ${m.cols.map((c) => c.name).join(',')} ${m.rels.map((x) => `${x.kind}:${x.target}:${x.key}`).join(',')}`), ['Post id,title,authorId belongsTo:User:authorId'])
  assert.deepEqual(findEnums(p, /state/i).map((e) => `${e.kind} ${e.name} ${e.values.map((v) => v.key).join(',')}`), ['prisma PostState DRAFT,LIVE'])
})

test('selectors: test ids in Vue (bound, template, concatenation) and Flutter; what a flow uses', () => {
  for (const crlf of [false, true]) {
    const web = [...codeSelectors(openRepo(repo(join(tmp(), 'web'), WEB, { crlf }), 'main')).keys()].sort()
    assert.deepEqual(web, ['order-badge-*', 'order-pay', 'order-row-*'])
    const app = [...codeSelectors(openRepo(repo(join(tmp(), 'app'), APP, { crlf }), 'main')).keys()].sort()
    assert.deepEqual(app, ['order_list', 'order_pay_button'])
  }
  const flow = "await page.getByTestId('order-pay').click()\nawait page.getByTestId(`order-row-${id}`)\npage.locator('[data-testid^=\"order-badge-\"]')\nawait tap({ id: 'order_pay_button' })\n"
  assert.deepEqual(flowSelectors(flow).sort(), ['order-badge-*', 'order-pay', 'order-row-*', 'order_pay_button'])
})

test('feature tags: several on a line, nearby lines are one place, templates skipped, config tags', () => {
  const r = openRepo(repo(join(tmp(), 'api'), { ...API, 'docs/howto.ts': '/**\n * @screen <screen>  @api <label>\n */\n' }), 'main')
  assert.deepEqual(tagsOf({}), ['@feature', '@screen', '@role'])
  assert.deepEqual(tagsOf({ featureTags: 'screen, @api' }), ['@screen', '@api'])
  const got = findTagged(r, tagsOf({ featureTags: '@screen, @api, @role' }))
  assert.deepEqual(got.map((t) => [t.file, t.line, t.tags]), [['src/services/order.service.ts', 2, { '@screen': 'Orders', '@api': 'list-orders', '@role': 'admin' }]])
})

test('gen writes the new maps, the reading order, and check stays quiet until something changes', () => {
  const ws = tmp()
  repo(join(ws, 'api'), API)
  repo(join(ws, 'web'), WEB)
  write(join(ws, '.tf', 'config.md'), '## Repos\n| key | path | base |\n|---|---|---|\n| api | `api/` | `main` |\n| web | `web/` | `main` |\n')
  write(join(ws, '.pipeline', 'T-1', 'flows', 'C1.mjs'), "await page.getByTestId('order-pay').click()\nawait page.getByTestId('order-gone').click()\n")
  write(join(ws, '.pipeline', 'T-1', 'flows.json'), JSON.stringify({ cases: { C1: { platform: 'web', lastResult: 'PASS', lastRunAt: '2026-11-01T00:00:00Z' } } }))
  write(join(ws, '.pipeline', 'T-1', 'cases.approved.json'), JSON.stringify({ cases: [{ id: 'C1', title: 'Pay an order', screen: 'Orders' }] }))
  const gen = () => spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'knowledge.mjs'), 'gen', ws], { encoding: 'utf8' })
  const r = gen()
  assert.equal(r.status, 0, r.stderr)
  const k = (f) => readFileSync(join(ws, 'knowledge', f), 'utf8')
  const manifest = JSON.parse(k('manifest.json'))
  for (const m of ['runtime', 'states', 'erd', 'e2e', 'features']) assert.ok(manifest.maps[m], `${m} written`)
  assert.match(k('runtime/async.md'), /`POST \/api\/payments\/ipn`/)
  assert.match(k('runtime/async.md'), /`GET \/api\/payments\/gateway-return`/)
  assert.doesNotMatch(k('runtime/async.md'), /payments\/\*/)
  assert.match(k('runtime/async.md'), /`order:updated` \| emit/)
  assert.match(k('states/orderstatus.md'), /`PAID` \| `paid` \| `src\/services\/order\.service\.ts:6`/)
  assert.match(k('erd/orders.md'), /belongsTo \*\*User\*\* via `user_id`/)
  assert.match(k('erd/orders.md'), /erDiagram/)
  assert.match(k('e2e/flows.md'), /\| `C1` \| Pay an order \| Orders \| web \| PASS \(2026-11-01\)/)
  assert.match(k('e2e/selectors.md'), /not defined in the code \(1\)[\s\S]*`order-gone` — T-1\/C1/)
  assert.match(k('features/README.md'), /\| Orders \| 1 \|/)
  const readme = k('README.md')
  const at = (s) => readme.indexOf(s)
  assert.ok(at('`features/README.md`') < at('`contracts/by-domain') && at('`contracts/by-domain') < at('`states/<enum>.md`') && at('`states/<enum>.md`') < at('`erd/<table>.md`') && at('`erd/<table>.md`') < at('`e2e/flows.md`'), readme)
  assert.deepEqual(check(ws).stale, [])
  // A flow edit makes e2e stale, nothing else.
  write(join(ws, '.pipeline', 'T-1', 'flows', 'C1.mjs'), "await page.getByTestId('order-pay').click()\n")
  assert.deepEqual(check(ws).stale.map((s) => s.map), ['e2e'])
})
