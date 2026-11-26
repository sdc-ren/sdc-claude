// tf knowledge — what a workspace is: one repo or several, each repo's stack, how it runs, what it documents,
// which code-index tools it has, what config and knowledge it already holds. Read-only: nothing is written.
// Every value says where it came from, so a draft built on it can be checked.
//
//   node <plugin>/scripts/init.mjs detect <root>     the profile as JSON
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { knowledgeOf, readConfig, repoRows } from '../../core/config.mjs'
import { configPath } from '../../core/paths.mjs'
import { which } from '../../core/platform.mjs'
import { SKIP, baseOf } from './source.mjs'

const TOOLS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tools.json'), 'utf8')).tools
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const json = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const text = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const posixRel = (from, to) => relative(from, to).split(sep).join('/') || '.'
const run = (bin, args, cwd) => { try { return execFileSync(bin, args, { cwd, stdio: 'pipe', windowsHide: true, timeout: 20_000 }).toString().trim() } catch { return null } }

// ── Repos ────────────────────────────────────────────────────────────────────
// The workspace's repos: the config's table when there is one, else every git checkout at the root or one or two
// levels down (a workspace folder that holds several repos).
export function findRepos(root, cfgText = '') {
  const rows = repoRows(cfgText)
  if (rows.length) return rows.map((r) => ({ key: r.key, path: r.path, abs: resolve(root, r.path), base: r.base, from: 'config' }))
  if (existsSync(join(root, '.git'))) return [{ key: keyOf(basename(resolve(root))), path: './', abs: resolve(root), base: '', from: 'git at the root' }]
  const out = []
  const scan = (dir, depth) => {
    let names = []
    try { names = readdirSync(dir).filter((n) => !n.startsWith('.')) } catch { return }
    for (const n of names.sort()) {
      const p = join(dir, n)
      if (!isDir(p) || SKIP.test(n)) continue
      if (existsSync(join(p, '.git'))) out.push({ key: keyOf(n), path: `${posixRel(root, p)}/`, abs: p, base: '', from: 'git checkout' })
      else if (depth < 2) scan(p, depth + 1)
    }
  }
  scan(resolve(root), 1)
  // Keys stay unique: a second "api" becomes "api-2".
  const seen = new Map()
  for (const r of out) { const n = (seen.get(r.key) || 0) + 1; seen.set(r.key, n); if (n > 1) r.key = `${r.key}-${n}` }
  return out
}
const keyOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'

// ── One repo ─────────────────────────────────────────────────────────────────
const FRAMEWORKS = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'],
  ['hono', 'Hono'], ['react-native', 'React Native'], ['expo', 'Expo'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'], ['electron', 'Electron'], ['vite', 'Vite'], ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'],
  ['sequelize', 'Sequelize'], ['typeorm', 'TypeORM'], ['mongoose', 'Mongoose'], ['drizzle-orm', 'Drizzle'], ['bullmq', 'BullMQ'],
  ['socket.io', 'Socket.IO'], ['@playwright/test', 'Playwright'], ['jest', 'Jest'], ['vitest', 'Vitest'], ['typescript', 'TypeScript'],
]
const MANIFESTS = [
  ['pubspec.yaml', 'Dart/Flutter'], ['go.mod', 'Go'], ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['composer.json', 'PHP'],
  ['pom.xml', 'Java (Maven)'], ['build.gradle', 'JVM (Gradle)'], ['build.gradle.kts', 'JVM (Gradle)'], ['Gemfile', 'Ruby'], ['Cargo.toml', 'Rust'],
  ['Package.swift', 'Swift'], ['mix.exs', 'Elixir'], ['*.csproj', '.NET'],
]
const LOCKS = [
  ['pnpm-lock.yaml', 'pnpm', 'node_modules'], ['yarn.lock', 'yarn', 'node_modules'], ['bun.lockb', 'bun', 'node_modules'], ['bun.lock', 'bun', 'node_modules'],
  ['package-lock.json', 'npm', 'node_modules'], ['pubspec.lock', 'flutter', '.dart_tool'], ['poetry.lock', 'poetry', '.venv'], ['uv.lock', 'uv', '.venv'],
  ['composer.lock', 'composer', 'vendor'], ['Gemfile.lock', 'bundler', 'vendor/bundle'], ['go.sum', 'go', ''], ['Cargo.lock', 'cargo', 'target'],
]
const DOCS = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'docs', 'doc', 'adr', 'docs/adr', '.cursor/rules', '.github/copilot-instructions.md']
const DOMAIN_DIRS = ['src/modules', 'src/features', 'src/domains', 'src/domain', 'src/routes', 'src/api', 'src/app', 'app', 'apps', 'packages', 'lib/features', 'lib/modules', 'lib/presentation', 'modules', 'features', 'services']

function portsOf(repo, pkg) {
  const out = new Set()
  for (const f of ['.env.example', '.env.sample', '.env.local.example', '.env.development']) {
    // The app's own port only: PORT, APP_PORT, SERVER_PORT, HTTP_PORT, NUXT_PORT, VITE_PORT … — not a database's or a cache's.
    for (const m of text(join(repo, f)).matchAll(/^\s*((?:[A-Z]+_)?PORT)\s*=\s*(\d{2,5})\s*$/gm)) {
      if (/^(DB|DATABASE|POSTGRES|PG|MYSQL|MONGO|MONGODB|REDIS|CACHE|SMTP|MAIL|RABBIT|RABBITMQ|KAFKA|ES|ELASTIC|MINIO|S3)_/.test(m[1])) continue
      out.add(`${m[2]} (${f} ${m[1]})`)
    }
  }
  for (const [name, cmd] of Object.entries((pkg && pkg.scripts) || {})) {
    const m = String(cmd).match(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/)
    if (m) out.add(`${m[1]} (scripts.${name})`)
  }
  return [...out]
}

function envNames(repo) {
  for (const f of ['.env.example', '.env.sample', '.env.local.example']) {
    const t = text(join(repo, f))
    if (t) return { file: f, names: [...t.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]) }
  }
  return { file: '', names: [] }
}

function domains(repo) {
  for (const d of DOMAIN_DIRS) {
    const p = join(repo, d)
    if (!isDir(p)) continue
    let names = []
    try { names = readdirSync(p).filter((n) => !n.startsWith('.') && !n.startsWith('_') && isDir(join(p, n)) && !SKIP.test(n)) } catch {}
    if (names.length >= 2) return { dir: d, names: names.slice(0, 40) }
  }
  return { dir: '', names: [] }
}

export function describeRepo(r) {
  const repo = r.abs
  const pkg = json(join(repo, 'package.json'))
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {}
  const stack = []
  for (const [dep, name] of FRAMEWORKS) if (deps[dep] && !stack.includes(name)) stack.push(name)
  if (pkg && !stack.length) stack.push('Node.js')
  let names = []
  try { names = readdirSync(repo) } catch {}
  for (const [file, name] of MANIFESTS) {
    const hit = file.startsWith('*') ? names.some((n) => n.endsWith(file.slice(1))) : names.includes(file)
    if (hit && !stack.includes(name)) stack.push(name)
  }
  const lock = LOCKS.find(([f]) => names.includes(f))
  const monorepo = pkg && pkg.workspaces ? 'package.json workspaces'
    : names.includes('pnpm-workspace.yaml') ? 'pnpm workspace' : names.includes('turbo.json') ? 'Turborepo'
      : names.includes('nx.json') ? 'Nx' : names.includes('melos.yaml') ? 'Melos' : ''
  const scripts = {}
  for (const k of ['dev', 'start', 'start:dev', 'serve', 'build', 'test', 'test:e2e', 'lint', 'typecheck']) if (pkg && pkg.scripts && pkg.scripts[k]) scripts[k] = pkg.scripts[k]
  const indexes = TOOLS.map((t) => ({ tool: t.name, indexed: isDir(join(repo, t.indexDir)) }))
  return {
    ...r,
    base: baseOf(repo, r.base),
    stack,
    packageManager: lock ? lock[1] : pkg ? 'npm' : '',
    lockfile: lock ? lock[0] : '',
    reusable: lock ? lock[2] : '',
    monorepo,
    scripts,
    ports: portsOf(repo, pkg),
    env: envNames(repo),
    docs: DOCS.filter((d) => existsSync(join(repo, d))),
    openapi: names.filter((n) => /^(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(n)),
    playwright: !!deps['@playwright/test'],
    domains: domains(repo),
    indexes,
  }
}

// ── Workspace ────────────────────────────────────────────────────────────────
function knowledgeState(root, cfgText) {
  const k = knowledgeOf(cfgText)
  const entry = k.entry || 'knowledge/README.md'
  const dir = dirname(resolve(root, entry))
  const manifest = json(join(dir, 'manifest.json'))
  const ownedByTf = !!(manifest && manifest.generator === 'tf')
  // A workspace's own generator: a script folder named like knowledge with a gen script in it.
  let generator = ''
  for (const d of ['scripts/knowledge', 'tools/knowledge', 'scripts']) {
    for (const f of ['gen.mjs', 'gen.js', 'generate.mjs', 'knowledge.mjs']) if (isFile(join(root, d, f)) && (d !== 'scripts' || f === 'knowledge.mjs')) { generator = `${d}/${f}`; break }
    if (generator) break
  }
  // The commands its README lists (code spans that run node/npm/… and mention the generator's folder).
  const readme = text(resolve(root, entry))
  const commands = [...readme.matchAll(/`((?:node|npm|pnpm|yarn|npx|bun|python3?|make)\s[^`]+)`/g)].map((m) => m[1]).filter((c, i, a) => a.indexOf(c) === i)
  return {
    configured: Object.keys(k).length > 0, ...k,
    entryPath: entry, exists: isFile(resolve(root, entry)), dirExists: isDir(dir), ownedByTf, generator, readmeCommands: commands.slice(0, 12),
  }
}

export function detect(rootIn) {
  const root = resolve(rootIn)
  const cfgFile = configPath(root)
  const cfgText = readConfig(root)
  const repos = findRepos(root, cfgText).map(describeRepo)
  const tools = TOOLS.map((t) => {
    const bin = which(t.bin)
    return { name: t.name, installed: !!bin, version: bin ? run(t.bin, t.version, root) || '' : '', why: t.why, missingIn: repos.filter((r) => !isDir(join(r.abs, t.indexDir))).map((r) => r.key) }
  })
  return {
    root,
    shape: repos.length === 0 ? 'no repo' : repos.length === 1 ? (repos[0].path === './' ? 'single repo' : 'one repo in a folder') : 'several repos',
    config: { path: posixRel(root, cfgFile), exists: !!cfgText },
    repos,
    tools,
    knowledge: knowledgeState(root, cfgText),
    agentFiles: { 'CLAUDE.md': isFile(join(root, 'CLAUDE.md')), 'AGENTS.md': isFile(join(root, 'AGENTS.md')) },
    gh: run('gh', ['auth', 'status'], root) !== null,
  }
}
