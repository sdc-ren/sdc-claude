// tf — GitHub Copilot host: how one job runs, as `copilot -p` (Copilot CLI's programmatic mode). Used by
// runtime/process.mjs. Written from Copilot CLI's documentation; not run against a real Copilot yet.
//
// Each job gets: the workspace as its folder (cwd), tf's state folder reachable (--add-dir), no questions to a
// person (--no-ask-user), the commands a tf job needs allowed (git, node, package managers, gh) and everything
// else sent to Copilot's safety review (--assisted-approval) instead of being refused. Only the final answer is
// printed (-s). The tool guard is the plugin's PreToolUse hook (hooks.json); it acts only in a process that has
// TF_JOB. TF_COPILOT_MODELS ({"small": "…", "medium": "…", "large": "…"}) picks a model per tier; without it
// Copilot's default model runs every job. TF_COPILOT_ARGS (JSON array) adds flags.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

import { stateDir } from '../../core/paths.mjs'

// What a tf job runs without asking: its own scripts and the repos' toolchains. Anything else goes to review.
export const ALLOWED = ['write', 'shell(git:*)', 'shell(node:*)', 'shell(npm:*)', 'shell(npx:*)', 'shell(pnpm:*)', 'shell(yarn:*)', 'shell(gh:*)', 'shell(flutter:*)', 'shell(dart:*)']

const fromEnv = (name, fallback) => { try { return JSON.parse(process.env[name] || '') } catch { return fallback } }

export function promptArgs({ prompt, tier, models = fromEnv('TF_COPILOT_MODELS', {}), extra = fromEnv('TF_COPILOT_ARGS', []) }) {
  const model = models && models[tier]
  return [
    '-p', prompt, '-s', '--no-ask-user', '--assisted-approval',
    '--add-dir', stateDir(),
    ...ALLOWED.flatMap((t) => ['--allow-tool', t]),
    ...(model ? ['--model', String(model)] : []),
    ...(Array.isArray(extra) ? extra.map(String) : []),
  ]
}

function launch(bin, args, { cwd, env }) {
  return new Promise((done) => {
    const p = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
    p.on('error', (e) => done({ code: 127, out, err: String(e.message || e) }))
    p.on('close', (code) => done({ code: code ?? 1, out, err }))
  })
}

/**
 * No resume: a job whose answer does not match is run again, told to look at what an earlier attempt left.
 * @param {{ plugin: string, root?: string, bin?: string, log?: (line: string) => void }} o
 */
export function copilotDriver({ plugin, bin = process.env.TF_COPILOT_BIN || 'copilot', log = () => {} }) {
  try { mkdirSync(stateDir(), { recursive: true }) } catch {}
  return {
    async run({ prompt, tier, cwd, env, label }) {
      const r = await launch(bin, promptArgs({ prompt, tier }), { cwd, env: { ...env, TF_PLUGIN: plugin } })
      if (r.code && !r.out.trim()) log(`${label}: copilot exited ${r.code}${r.err ? ` — ${r.err.trim().split('\n').pop()}` : ''}`)
      return { text: r.out, code: r.code }
    },
  }
}
