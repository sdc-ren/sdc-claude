// tf — Codex host: how one job runs, as `codex exec` (non-interactive Codex). Used by runtime/process.mjs.
//
// Each job gets: the workspace as its folder (-C), Codex's workspace-write sandbox with network on (installs,
// git push, the tracker), tf's state folder and the workspace repos' .git folders writable (--add-dir: the
// sandbox keeps .git read-only otherwise, and setup adds worktrees, the reviewer commits), and
// `--approve-for-me`: nobody is there to answer an approval, so a command that needs more than that goes to
// Codex's own automatic review instead of failing. The tool guard is the plugin's
// PreToolUse hook (hooks.json); it acts only in a process that has TF_JOB. The engine's tier picks the
// reasoning effort. TF_CODEX_ARGS (JSON array) adds flags.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stateDir } from '../../core/paths.mjs'

export const EFFORT = { small: 'low', medium: 'medium', large: 'high' }
const toml = (s) => JSON.stringify(String(s)) // a TOML basic string is a JSON string for these values

// The .git folders of the workspace: its own and its direct children's (the config's repos). A worktree's .git
// is a file pointing into its main repo's .git, which is in this list.
export function gitDirs(root) {
  const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
  const out = []
  if (isDir(join(root, '.git'))) out.push(join(root, '.git'))
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name) } catch {}
  for (const n of names) if (isDir(join(root, n, '.git'))) out.push(join(root, n, '.git'))
  return out
}

export function execArgs({ cwd, tier, out, extra = [], writable = [] }) {
  return [
    'exec', '--json', '--skip-git-repo-check',
    '-C', cwd,
    '--approve-for-me', ...[stateDir(), ...writable].filter((d) => existsSync(d)).flatMap((d) => ['--add-dir', d]),
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', `model_reasoning_effort=${toml(EFFORT[tier] || 'medium')}`,
    '-o', out,
    ...extra,
    '-',
  ]
}

const extraFromEnv = () => { try { const a = JSON.parse(process.env.TF_CODEX_ARGS || '[]'); return Array.isArray(a) ? a.map(String) : [] } catch { return [] } }

// Run codex with the prompt on stdin; the final message is the -o file, the session id the thread.started event.
function launch(bin, args, { prompt, cwd, env, onLine }) {
  return new Promise((done) => {
    const p = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let session = '', buf = '', err = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try { const ev = JSON.parse(line); if (ev.type === 'thread.started' && ev.thread_id) session = ev.thread_id; onLine && onLine(ev) } catch {}
      }
    })
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
    p.on('error', (e) => done({ code: 127, session, err: String(e.message || e) }))
    p.on('close', (code) => done({ code: code ?? 1, session, err }))
    p.stdin.end(prompt)
  })
}

/**
 * @param {{ plugin: string, root?: string, bin?: string, log?: (line: string) => void }} o
 */
export function codexDriver({ plugin, root = '', bin = process.env.TF_CODEX_BIN || 'codex', log = () => {} }) {
  const writable = root ? gitDirs(root) : []
  try { mkdirSync(stateDir(), { recursive: true }) } catch {} // writable for the scripts' saved sessions and registry
  const tmp = mkdtempSync(join(tmpdir(), 'tf-codex-'))
  let n = 0
  const read = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  async function go(args, out, { prompt, cwd, env, label }) {
    const r = await launch(bin, args, { prompt, cwd, env })
    const text = read(out)
    rmSync(out, { force: true })
    if (r.code && !text) log(`${label}: codex exited ${r.code}${r.err ? ` — ${r.err.trim().split('\n').pop()}` : ''}`)
    return { text, code: r.code, session: r.session }
  }
  return {
    run({ prompt, tier, cwd, env, label }) {
      const out = join(tmp, `${++n}.txt`)
      return go(execArgs({ cwd, tier, out, writable, extra: extraFromEnv() }), out, { prompt, cwd, env: { ...env, TF_PLUGIN: plugin }, label })
    },
    resume({ session, prompt, tier, cwd, env, label }) {
      const out = join(tmp, `${++n}.txt`)
      const args = ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `model_reasoning_effort=${toml(EFFORT[tier] || 'medium')}`, '-o', out, session, '-']
      return go(args, out, { prompt, cwd, env: { ...env, TF_PLUGIN: plugin }, label })
    },
  }
}
