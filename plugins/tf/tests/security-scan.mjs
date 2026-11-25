// security-scan.mjs: the built-in first pass of the S categories in guidelines/review-standard.md.
// Run: node --test plugins/tf/tests/security-scan.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dedupe, maskSecret, scanDiff, summary } from '../scripts/security-scan.mjs'

const S = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'security-scan.mjs')
const g = (wt, ...args) => {
  const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

function repo() {
  const wt = mkdtempSync(join(tmpdir(), 'tf-sec-test-'))
  g(wt, 'init', '-q', '-b', 'main')
  g(wt, 'config', 'user.email', 't@example.test')
  g(wt, 'config', 'user.name', 't')
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }))
  writeFileSync(join(wt, 'app.js'), 'const a = 1\n')
  g(wt, 'add', '.')
  g(wt, 'commit', '-q', '-m', 'base')
  g(wt, 'checkout', '-q', '-b', 'feat')
  return wt
}

test('secrets and sensitive log values on added lines are found, masked, with file and line', () => {
  const wt = repo()
  const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP'
  writeFileSync(join(wt, 'app.js'), `const a = 1\nconst key = "${aws}"\nconsole.log('login', user.password)\n`)
  g(wt, 'commit', '-qam', 'x')
  const r = scanDiff(wt, 'main')
  const secret = r.findings.find((f) => f.rule === 'aws-access-key')
  assert.deepEqual([secret.s, secret.file, secret.line], ['S5', 'app.js', 2])
  assert.ok(!JSON.stringify(r).includes(aws), 'the secret is never printed whole')
  const log = r.findings.find((f) => f.rule === 'sensitive-value-in-log')
  assert.deepEqual([log.s, log.line], ['S3', 3])
})

test('placeholders and env lookups are not secrets; lines already on the base are not scanned', () => {
  const wt = repo()
  writeFileSync(join(wt, 'app.js'), 'const a = 1\nconst password = "changeme123"\nconst token = process.env.TOKEN\n')
  const r = scanDiff(wt, 'main')
  assert.equal(r.findings.length, 0)
})

test('untracked files are scanned without touching the index; sensitive areas and new dependencies are listed', () => {
  const wt = repo()
  mkdirSync(join(wt, 'src', 'migrations'), { recursive: true })
  writeFileSync(join(wt, 'src', 'migrations', '001-audit.js'), 'export const up = () => assertLockOverride(user)\n')
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0', 'expresss-helper': '1.0.0' } }))
  const r = scanDiff(wt, 'main')
  const areas = r.sensitive.map((s) => s.area)
  for (const a of ['migration', 'audit', 'permission']) assert.ok(areas.includes(a), `${a} in ${areas}`)
  assert.deepEqual(r.deps.map((d) => [d.name, d.was]), [['expresss-helper', null]])
  assert.equal(g(wt, 'diff', '--cached', '--name-only'), '', 'nothing staged by the scan')
})

test('cli: --no-tools reports each scanner as skipped, never as a pass; usage error exits 2', () => {
  const wt = repo()
  const r = spawnSync(process.execPath, [S, wt, '--base', 'main', '--no-tools'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.match(j.tools.gitleaks, /^skipped/)
  assert.equal(spawnSync(process.execPath, [S, wt], { encoding: 'utf8' }).status, 2)
  assert.equal(maskSecret('abcdefghijkl'), 'abcd…(12 chars)')
})

test('--out keeps the JSON in the file and prints a short summary; one finding per category, file and line', () => {
  const merged = dedupe([
    { s: 'S5', rule: 'slack-token', file: 'a.js', line: 1, text: 'xoxb…' },
    { s: 'S5', rule: 'gitleaks:slack-bot-token', file: 'a.js', line: 1, text: 'REDACTED' },
    { s: 'S3', rule: 'sensitive-value-in-log', file: 'a.js', line: 1, text: 'console.log(token)' },
  ])
  assert.deepEqual(merged.map((f) => [f.s, f.rule]), [['S5', 'slack-token, gitleaks:slack-bot-token'], ['S3', 'sensitive-value-in-log']])
  const text = summary({ findings: merged, sensitive: [{ area: 'auth' }], deps: [], tools: { gitleaks: 'ran', semgrep: 'not installed' } }, '/x/sec.json')
  assert.match(text, /^security-scan: 2 findings \(S5 ×1, S3 ×1\)\nsensitive: auth\ndeps: none\ngitleaks ran · semgrep not installed/)
  assert.match(text, /full report: \/x\/sec\.json$/)
  const wt = repo()
  const out = join(wt, 'sec.json')
  const r = spawnSync(process.execPath, [S, wt, '--base', 'main', '--no-tools', '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stdout.trim().startsWith('{'), 'no JSON on stdout')
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).base, 'main')
})
