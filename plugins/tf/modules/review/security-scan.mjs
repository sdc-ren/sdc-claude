#!/usr/bin/env node
// tf: the deterministic first pass of the security categories in guidelines/review-standard.md (S1–S7), run by
// the dev before it reports and by the gate, on a task worktree, before any model judges the code.
//
//   node security-scan.mjs <worktree> --base <ref> [--out <file.json>] [--no-tools]
//     with --out the full JSON goes to the file and only a short summary is printed (what an agent reads);
//     without --out it prints the JSON object: { base, files, sensitive, findings, deps, tools }
//     - findings: [{ s, rule, file, line, text }] on the lines this change ADDED (committed or not): built-in
//       (S5 secrets, S3 sensitive values in log calls), plus what the installed scanners report;
//       secret values are masked, never printed whole
//     - sensitive: areas the diff touches that make the change security-sensitive (auth, permission, money…)
//     - deps: packages added or re-versioned in package.json / pubspec.yaml (S6: check each one exists and is
//       the intended package)
//     - tools: gitleaks / semgrep / npm-audit → "ran" | "not installed" | "skipped: <why>" | "failed: <why>"
//     - preExisting: per scanner, results on lines the change did not add (there on the base; not counted)
//     exit 0 with the report (findings do not change the exit code); exit 2 on a usage or git error.
//   --no-tools runs only the built-in checks (tests, or a machine where scanners must not run).
//   import { scanDiff, maskSecret } from './security-scan.mjs'
import { isMain as startedAsMain } from '../../core/main.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { which } from '../../core/platform.mjs'

const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['assigned-secret', /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|private[_-]?key)\w*["']?\s*[:=]\s*["'`]([^"'`\s$<>{}]{8,})["'`]/i],
]
// A value that only looks like a secret: placeholders, env lookups, test markers.
const PLACEHOLDER = /^(?:x+|\*+|changeme|change[_-]?me|example|placeholder|dummy|test|secret|password|your[_-]|<|\$\{|process\.env)/i
const LOG_CALL = /\b(?:console\.(?:log|info|warn|error|debug)|logger\.(?:log|info|warn|error|debug|trace)|log\.(?:info|warn|error|debug|d|e|i|w)|print|debugPrint|Log\.[dewiv])\s*\(/
const LOG_SENSITIVE = /\b(?:password|passwd|otp|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|card[_-]?number|cvv)\b/i
const SENSITIVE_AREAS = [
  ['auth', /\b(?:auth|login|logout|session|jwt|otp|password|oauth|sso)\b/i],
  ['permission', /\b(?:permission|role|guard|policy|acl|privileged|is[_-]?admin|owner|can[A-Z_]\w*|assert\w*(?:Lock|Access|Owner|Role))/],
  ['lock', /\b(?:lock|unlock|locked|finaliz\w*|unfinaliz\w*|approve\w*)\b/i],
  ['money', /\b(?:payment|payout|prize|wallet|refund|invoice|amount|balance|price|fee)\b/i],
  ['audit', /\baudit\w*\b/i],
  ['migration', /(?:^|\/)migrations?\//i],
  ['crypto', /\b(?:crypto|hash|bcrypt|argon|hmac|encrypt|decrypt|sign(?:ature)?)\b/i],
  ['webhook', /\bwebhook\w*\b/i],
]

// Prose and lockfiles: scanned for secrets, but they do not make a change sensitive and have no log calls.
const NOT_CODE = /\.(?:md|mdx|txt|rst|adoc|lock)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pubspec\.lock|CHANGELOG[^/]*)$/i
const isCode = (f) => !NOT_CODE.test(f)

export const maskSecret = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…(${s.length} chars)`)

function git(wt, args) {
  const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`)
  return r.stdout
}

// Added lines of the change against the merge base, committed and uncommitted (untracked files included).
function addedLines(wt, base) {
  const mb = git(wt, ['merge-base', base, 'HEAD']).trim()
  const diff = git(wt, ['diff', '--unified=0', '--no-color', '--no-ext-diff', mb])
  const out = []
  let file = '', line = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (h) { line = Number(h[1]); continue }
    if (l.startsWith('+') && file !== '/dev/null') { out.push({ file, line, text: l.slice(1) }); line++ }
  }
  // Untracked files are new in full; read them instead of touching the index.
  for (const f of git(wt, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    let text = ''
    try { text = readFileSync(join(wt, f), 'utf8') } catch { continue }
    if (text.includes('\0')) continue // binary
    text.split('\n').forEach((t, i) => out.push({ file: f, line: i + 1, text: t }))
  }
  return { mb, lines: out }
}

// Dependencies added or changed in manifests: compares the manifest at the merge base with the worktree.
function depChanges(wt, mb, files) {
  const deps = []
  for (const f of files) {
    const name = f.split('/').pop()
    if (name !== 'package.json' && name !== 'pubspec.yaml') continue
    const now = existsSync(join(wt, f)) ? readFileSync(join(wt, f), 'utf8') : ''
    let before = ''
    try { before = git(wt, ['show', `${mb}:${f}`]) } catch { before = '' }
    const parse = name === 'package.json' ? npmDeps : pubDeps
    const a = parse(before), b = parse(now)
    for (const [pkg, v] of Object.entries(b)) if (a[pkg] !== v) deps.push({ file: f, ecosystem: name === 'package.json' ? 'npm' : 'pub', name: pkg, version: v, was: a[pkg] || null })
  }
  return deps
}
function npmDeps(text) {
  try {
    const j = JSON.parse(text || '{}')
    return { ...j.dependencies, ...j.devDependencies, ...j.optionalDependencies, ...j.peerDependencies }
  } catch { return {} }
}
function pubDeps(text) {
  const out = {}
  let inDeps = false
  for (const l of String(text).split('\n')) {
    if (/^(?:dependencies|dev_dependencies|dependency_overrides):\s*$/.test(l)) { inDeps = true; continue }
    if (/^\S/.test(l)) inDeps = false
    const m = inDeps && l.match(/^ {2}([a-z0-9_]+):\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim() || '(nested)'
  }
  return out
}

export function scanDiff(wt, base) {
  const { mb, lines } = addedLines(wt, base)
  const files = [...new Set(lines.map((l) => l.file))]
  const findings = []
  for (const { file, line, text } of lines) {
    for (const [rule, re] of SECRET_RULES) {
      const m = text.match(re)
      if (!m) continue
      const value = m[1] || m[0]
      if (rule === 'assigned-secret' && PLACEHOLDER.test(value)) continue
      findings.push({ s: 'S5', rule, file, line, text: maskSecret(value) })
      break
    }
    if (isCode(file) && LOG_CALL.test(text) && LOG_SENSITIVE.test(text)) findings.push({ s: 'S3', rule: 'sensitive-value-in-log', file, line, text: text.trim().slice(0, 120) })
  }
  const sensitive = []
  for (const [area, re] of SENSITIVE_AREAS) {
    const hit = files.filter((f) => isCode(f) && re.test(f)).concat(lines.filter((l) => isCode(l.file) && re.test(l.text)).map((l) => l.file))
    if (hit.length) sensitive.push({ area, files: [...new Set(hit)].slice(0, 10) })
  }
  const report = { base, mergeBase: mb, files, sensitive, findings, deps: depChanges(wt, mb, files), preExisting: {} }
  // Which lines this change added, per file: the scanners report whole files, and only these lines are its own.
  Object.defineProperty(report, 'added', { value: lines, enumerable: false })
  return report
}

// A scanner from PATH. On Windows a .cmd/.bat shim cannot run without a shell, so it is skipped and said so.
function tool(bin) {
  const p = which(bin)
  if (!p) return { p: '', why: 'not installed' }
  if (/\.(?:cmd|bat)$/i.test(p)) return { p: '', why: 'skipped: a .cmd shim needs a shell — run it by hand' }
  return { p, why: '' }
}
const run = (p, args, cwd, timeout = 300_000) => spawnSync(p, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 })

// A finding on a line this change did not add was there on the base: counted apart, never as the change's.
function addedSet(report) {
  const by = new Map()
  for (const l of report.added) {
    if (!by.has(l.file)) by.set(l.file, new Set())
    by.get(l.file).add(l.line)
  }
  return (file, from, to = from) => {
    const set = by.get(file)
    if (!set) return false
    for (let n = from; n <= to; n++) if (set.has(n)) return true
    return false
  }
}
const lastLine = (r) => (r.stderr || r.error?.message || '').trim().split('\n').pop()

function runTools(wt, report) {
  const tools = {}
  const tmp = mkdtempSync(join(tmpdir(), 'tf-sec-'))
  const isAdded = addedSet(report)
  const pre = (tool) => { report.preExisting[tool] = (report.preExisting[tool] || 0) + 1 }
  try {
    // gitleaks: a mirror of the change — each file with only its added lines, the rest blank so line numbers hold.
    // Dev and gate run before anything is committed, so scanning commits would miss the code under review.
    const gl = tool('gitleaks')
    if (!gl.p) tools.gitleaks = gl.why
    else {
      const src = join(tmp, 'src'), out = join(tmp, 'gitleaks.json')
      const byFile = new Map()
      for (const l of report.added) {
        if (!byFile.has(l.file)) byFile.set(l.file, [])
        byFile.get(l.file)[l.line - 1] = l.text
      }
      for (const [f, rows] of byFile) {
        mkdirSync(dirname(join(src, f)), { recursive: true })
        writeFileSync(join(src, f), Array.from(rows, (x) => x ?? '').join('\n') + '\n')
      }
      const common = ['--report-format', 'json', '--report-path', out, '--exit-code', '0', '--no-banner', '--redact']
      let r = run(gl.p, ['dir', src, ...common], tmp)
      if (r.status !== 0 && /unknown command/i.test(r.stderr || '')) r = run(gl.p, ['detect', '--no-git', '--source', src, ...common], tmp)
      if (r.status !== 0 || !existsSync(out)) tools.gitleaks = `failed: ${lastLine(r)}`
      else {
        tools.gitleaks = 'ran'
        for (const f of JSON.parse(readFileSync(out, 'utf8') || '[]')) {
          const file = relative(src, resolve(tmp, f.File)).split(sep).join("/")
          report.findings.push({ s: 'S5', rule: `gitleaks:${f.RuleID}`, file, line: f.StartLine, text: 'REDACTED' })
        }
      }
    }
    // semgrep: its recommended ruleset (p/default — it holds the OWASP rules and, unlike p/owasp-top-ten, catches
    // command injection) on the changed files as they are; only results on added lines are the change's.
    const sg = tool('semgrep')
    const targets = report.files.filter((f) => existsSync(join(wt, f)) && isCode(f))
    if (!sg.p) tools.semgrep = sg.why
    else if (!targets.length) tools.semgrep = 'skipped: no changed code file'
    else {
      const r = run(sg.p, ['scan', '--config', 'p/default', '--json', '--quiet', '--metrics', 'off', ...targets], wt)
      try {
        const j = JSON.parse(r.stdout || '')
        tools.semgrep = 'ran'
        for (const x of j.results || []) {
          if (!isAdded(x.path, x.start?.line, x.end?.line)) { pre('semgrep'); continue }
          const ow = newestOwasp(x.extra?.metadata?.owasp)
          report.findings.push({ s: ow ? `OWASP ${ow}` : 'S4', rule: `semgrep:${x.check_id}`, file: x.path, line: x.start?.line, text: String(x.extra?.message || '').slice(0, 160) })
        }
      } catch { tools.semgrep = `failed: ${lastLine(r)}` }
    }
    // npm audit: each package dir whose lockfile changed; high and critical only, and only for packages this change
    // added or re-versioned — the rest were on the base.
    const locks = report.files.filter((f) => f.split('/').pop() === 'package-lock.json')
    const mine = new Set(report.deps.filter((d) => d.ecosystem === 'npm').map((d) => d.name))
    const npm = tool('npm')
    if (!locks.length) tools['npm-audit'] = 'skipped: no lockfile changed'
    else if (!npm.p) tools['npm-audit'] = npm.why
    else {
      tools['npm-audit'] = 'ran'
      for (const lock of locks) {
        const r = run(npm.p, ['audit', '--json', '--audit-level=high'], join(wt, dirname(lock)), 120_000)
        try {
          const v = JSON.parse(r.stdout || '{}').vulnerabilities || {}
          for (const [name, x] of Object.entries(v)) {
            if (x.severity !== 'high' && x.severity !== 'critical') continue
            const via = (x.effects || []).concat(name)
            if (!via.some((n) => mine.has(n))) { pre('npm-audit'); continue }
            report.findings.push({ s: 'S6', rule: `npm-audit:${x.severity}`, file: lock, line: 0, text: `${name} ${x.range || ''}`.trim() })
          }
        } catch { tools['npm-audit'] = `failed in ${dirname(lock) || '.'}: ${lastLine(r)}` }
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }) }
  return tools
}

// A rule lists its OWASP row for several editions ("A01:2017 - Injection", "A05:2025 - Injection"): keep the newest.
export function newestOwasp(list) {
  const rows = [].concat(list || []).map((x) => String(x).match(/^(A\d{2}):(\d{4})/)).filter(Boolean)
  rows.sort((a, b) => Number(b[2]) - Number(a[2]))
  return rows.length ? `${rows[0][1]}:${rows[0][2]}` : ''
}

// One finding per category, file and line: the built-in check and a scanner often flag the same secret.
export function dedupe(findings) {
  const by = new Map()
  for (const f of findings) {
    const k = `${f.s}|${f.file}|${f.line}`
    const had = by.get(k)
    if (!had) by.set(k, { ...f })
    else if (!had.rule.split(', ').includes(f.rule)) had.rule += `, ${f.rule}`
  }
  return [...by.values()]
}

// What an agent reads when the full report went to a file: a few lines, never the whole JSON in its context.
export function summary(r, out, max = 20) {
  const count = {}
  for (const f of r.findings) count[f.s] = (count[f.s] || 0) + 1
  const head = [
    `security-scan: ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${r.findings.length ? ` (${Object.entries(count).map(([s, n]) => `${s} ×${n}`).join(', ')})` : ''}`,
    `sensitive: ${r.sensitive.map((s) => s.area).join(', ') || 'none'}`,
    `deps: ${r.deps.length ? r.deps.map((d) => `${d.ecosystem}:${d.name}@${d.version}${d.was ? ` (was ${d.was})` : ' (new)'}`).join(', ') : 'none'}`,
    Object.entries(r.tools).map(([t, s]) => `${t} ${s}`).join(' · '),
    ...(Object.keys(r.preExisting || {}).length ? [`pre-existing on the base (not this change's): ${Object.entries(r.preExisting).map(([t, n]) => `${t} ${n}`).join(', ')}`] : []),
  ].join('\n')
  const short = (rule) => rule.split(', ').map((x) => x.replace(/^semgrep:(?:[\w-]+\.)*([\w-]+)$/, 'semgrep:$1')).join(', ')
  const lines = r.findings.slice(0, max).map((f) => `- [${f.s}] ${f.file}:${f.line} ${short(f.rule)} — ${String(f.text).slice(0, 100)}`)
  if (r.findings.length > max) lines.push(`- +${r.findings.length - max} more`)
  return [head, ...lines, `full report: ${out}`].join('\n')
}

const isMain = startedAsMain(import.meta.url, 'scripts/security-scan.mjs')
if (isMain) {
  const a = process.argv.slice(2)
  const flag = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a.splice(i, 2)[1] : '' }
  const base = flag('base'), out = flag('out')
  const noTools = a.includes('--no-tools')
  const wt = a.find((x) => !x.startsWith('--'))
  if (!wt || !base) { console.error('usage: security-scan.mjs <worktree> --base <ref> [--out <file.json>] [--no-tools]'); process.exit(2) }
  try {
    const report = scanDiff(resolve(wt), base)
    report.tools = noTools ? { gitleaks: 'skipped: --no-tools', semgrep: 'skipped: --no-tools', 'npm-audit': 'skipped: --no-tools' } : runTools(resolve(wt), report)
    report.findings = dedupe(report.findings)
    const text = JSON.stringify(report, null, 1)
    if (!out) console.log(text)
    else { writeFileSync(out, text + '\n'); console.log(summary(report, out)) }
  } catch (e) { console.error(String(e.message || e)); process.exit(2) }
}
