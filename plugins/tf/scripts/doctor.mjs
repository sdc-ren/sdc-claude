#!/usr/bin/env node
// SDC tf doctor: check that this machine and workspace can run the tf plugin (/tf:build …).
//
//   node doctor.mjs <root>
//
// Generic checks (every workspace) + the workspace config's `## Doctor` section, one line per check:
//   - `<shell command>` — <label>        (pass = exit code 0; `<root>` is replaced by the workspace root)
// Prints a table; exit 1 when a required check fails. Optional checks only warn.

import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { SH, info, which } from './platform.mjs'
import { reaperInstalled } from './reaper.mjs'

const root = resolve(process.argv[2] || '.')
const cfgPath = join(root, '.claude', 'task-flow.md')
const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''
const sh = (cmd, timeout = 20_000) => { try { return { ok: true, out: execSync(cmd, { stdio: 'pipe', shell: SH, windowsHide: true, timeout, cwd: root }).toString().trim() } } catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message).trim() } } }
const rows = []
const check = (label, ok, detail = '', required = true) => rows.push({ label, status: ok ? 'ok' : required ? 'FAIL' : 'warn', detail: ok && !required ? '' : String(detail).split('\n')[0].slice(0, 110) })

// Tools
const nodeMajor = Number(process.versions.node.split('.')[0])
check('node ≥ 20', nodeMajor >= 20, process.version)
check('git', sh('git --version').ok, sh('git --version').out)
const gh = sh('gh auth status 2>&1')
check('gh installed + logged in', gh.ok, gh.ok ? 'authenticated' : gh.out)
check('codegraph CLI', !!which('codegraph'), 'used by PM/reviewer for impact search', false)
check('WebP encoder (cwebp/ffmpeg)', !!which('cwebp') || !!which('ffmpeg'), 'falls back to Playwright Chromium', false)
// What this operating system offers (scripts/platform.mjs).
const sys = info()
check(`system: ${sys.os}`, true)
check(`shell: ${sys.shell}`, sys.shellOk, sys.shellOk ? '' : 'Windows needs Git for Windows (Git Bash): the scripts and the config recipes run through it. Install it, or set CLAUDE_CODE_GIT_BASH_PATH to bash.exe')
check(`port lookup (${sys.portTool || 'none'})`, !!sys.portTool, 'install lsof: without it serve.mjs cannot tell whether a port is taken', false)
if (!sys.cwdOfProcess) check('owner of a busy port', false, 'Windows cannot tell which folder a process runs from: serve.mjs trusts the server it started itself', false)
if (!sys.chromeCookieImport) check('tracker login from Chrome cookies', false, 'macOS only — here `browser.mjs auth` opens a browser once for you to log in', false)
check(`dependency copy for new worktrees: ${sys.clone}`, sys.os === 'macos', 'a plain copy works, it is only slower', false)
check('reaper installed', reaperInstalled(), 'run: node <plugin>/scripts/reaper.mjs install', false)

// Claude setup
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const agents = ['pm', 'lead', 'dev', 'tester', 'reviewer'].filter((a) => !existsSync(join(PLUGIN, 'agents', `${a}.md`)))
check('plugin agents tf:pm/lead/dev/tester/reviewer', !agents.length, agents.length ? `missing: ${agents.join(', ')}` : '')
const gl = ['git', 'pr-description', 'pr-review', 'ticket-comment', 'e2e-testing'].filter((g) => !existsSync(join(PLUGIN, 'guidelines', `${g}.md`)))
check('plugin guidelines', !gl.length, gl.length ? `missing: ${gl.join(', ')}` : '')
check('workspace config .claude/task-flow.md', !!cfg, cfgPath)

// Workspace repos from the config table: | key | `path/` | `base` …
for (const m of cfg.matchAll(/^\|\s*([\w-]+)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`/gm)) {
  const [, key, path, base] = m
  const p = join(root, path)
  const isRepo = sh(`git -C ${JSON.stringify(p)} rev-parse --git-dir`).ok
  const hasBase = isRepo && sh(`git -C ${JSON.stringify(p)} rev-parse --verify --quiet origin/${base}`).ok
  check(`repo ${key} (${path}, origin/${base})`, isRepo && hasBase, !isRepo ? 'not a git repo' : !hasBase ? `origin/${base} missing — git fetch` : '')
}

// Playwright package from the config
const pw = (cfg.match(/Playwright package:\s*`([^`]+)`/) || [])[1]
if (pw) {
  const pj = pw.replace('<root>', root)
  let ok = false
  try { createRequire(resolve(pj))('@playwright/test'); ok = true } catch { try { createRequire(resolve(pj))('playwright'); ok = true } catch {} }
  check('Playwright (config)', ok, pj)
}

// Workspace-specific checks: ## Doctor section
const sec = cfg.split(/^## /m).find((s) => s.startsWith('Doctor'))
if (sec) {
  for (const m of sec.matchAll(/^- `([^`]+)`\s*[—-]\s*(.+?)(\s*\(optional\))?$/gm)) {
    const r = sh(m[1].replaceAll('<root>', root), 60_000)
    check(m[2].trim(), r.ok, r.ok ? '' : r.out, !m[3])
  }
}

const w = Math.max(...rows.map((r) => r.label.length))
for (const r of rows) console.log(`${r.status === 'ok' ? '✓' : r.status === 'warn' ? '!' : '✗'} ${r.label.padEnd(w)}  ${r.detail}`)
const fails = rows.filter((r) => r.status === 'FAIL').length
console.log(`\n${fails ? `${fails} required check(s) failed` : 'ready'} · ${rows.filter((r) => r.status === 'warn').length} warning(s)`)
process.exit(fails ? 1 : 0)
