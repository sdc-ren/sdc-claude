// tf runtime — the engine's Runtime port for hosts that run an agent as a command line (Codex, Copilot, …):
// every job is its own process, started by a host driver. Host-neutral: the driver says how to start that
// host's agent; this file builds the job's prompt, tells the guard which job it is, checks the answer against
// the schema and asks again when it does not match.
//
//   processRuntime({ driver, root, plugin, log, concurrency }) → { agent, parallel, phase, log, budget }
//   driver.run({ prompt, tier, cwd, env, label }) → { text, code }  (text = the agent's final message)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseJob } from '../core/guard-rules.mjs'
import { lastJson, validate } from '../engine/src/validate.mjs'

// The engine names models by tier; a driver maps a tier to its host's model or effort.
export const TIERS = { haiku: 'small', sonnet: 'medium', opus: 'large' }

// A role's instructions: the role file without its front matter, with the plugin root written out (a process
// host does not fill placeholders itself).
export function rolePrompt(plugin, role) {
  let text = ''
  try { text = readFileSync(join(plugin, 'agents', `${role}.md`), 'utf8').replace(/\r\n/g, '\n') } catch { return '' }
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin).trim()
}

const ANSWER = (schema) =>
  `\n\n## Your answer\nWhen the job is done, your final message is ONLY one JSON object (no prose around it) matching this JSON Schema:\n` +
  '```json\n' + JSON.stringify(schema) + '\n```'

// At most n promises at once, results in order.
function limiter(n) {
  let active = 0
  const queue = []
  const next = () => { if (active >= n || !queue.length) return; active++; const { fn, ok, ko } = queue.shift(); fn().then(ok, ko).finally(() => { active--; next() }) }
  return (fn) => new Promise((ok, ko) => { queue.push({ fn, ok, ko }); next() })
}

/**
 * @param {{ driver: { run: Function }, root: string, plugin: string, log?: (line: string) => void, concurrency?: number, tries?: number }} o
 */
export function processRuntime({ driver, root, plugin, log = () => {}, concurrency = 4, tries = 2 }) {
  const slot = limiter(Math.max(1, concurrency))
  async function agent(prompt, opts = {}) {
    const type = String(opts.agentType || '')
    const role = type.replace(/^tf[:-]/, '')
    const instructions = rolePrompt(plugin, role)
    const job = parseJob(prompt, type) // what the guard hook enforces for this process (null: no tf job)
    const env = job ? { TF_JOB: JSON.stringify(job) } : {}
    const tier = TIERS[opts.model] || 'medium'
    const label = opts.label || role
    const first = (instructions ? `${instructions}\n\n---\n\n` : '') + prompt + (opts.schema ? ANSWER(opts.schema) : '')
    let out = await slot(() => driver.run({ prompt: first, tier, effort: opts.effort, cwd: root, env, label }))
    if (!opts.schema) return out.text
    for (let attempt = 1; ; attempt++) {
      const answer = lastJson(out.text)
      const wrong = answer ? validate(answer, opts.schema) : [out.code ? `the agent stopped (exit ${out.code})` : 'no JSON object in the final message']
      if (!wrong.length) return answer
      const again = attempt < tries
      log(`${label}: answer does not match the schema (${wrong.slice(0, 3).join('; ')})${again ? ' — asking again' : ''}`)
      if (!again) return null
      const fix = `Your final message was not valid: ${wrong.slice(0, 8).join('; ')}. Reply with the JSON object only.${ANSWER(opts.schema)}`
      // The same agent session when the host can resume it (it knows what it did); else a new one told to look first.
      out = await slot(() => (out.session && driver.resume
        ? driver.resume({ session: out.session, prompt: fix, tier, cwd: root, env, label })
        : driver.run({ prompt: `${first}\n\nAn earlier attempt at this job may have left work on disk: look at the worktree and the task folder first, finish what is missing, do not redo what is done.`, tier, effort: opts.effort, cwd: root, env, label })))
    }
  }
  return {
    agent,
    parallel: (fns) => Promise.all(fns.map((f) => f())),
    phase: (title) => log(`── ${title}`),
    log,
    budget: { total: 0, remaining: () => Infinity },
  }
}
