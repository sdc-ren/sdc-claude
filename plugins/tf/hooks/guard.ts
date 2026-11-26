// tf — tool guard, Claude Code wiring. The rules themselves are host-neutral and live in core/guard-rules.mjs
// (what is refused and why); this file only connects them to this host's events.
// A job is recognised when the executor starts it (`agent.spawn`: the prompt begins "Job J<n> · role …") and
// its tool calls carry that agent's id; any other agent of this plugin (subagent type tf:…) gets the rules for
// every agent. Anything unrecognised, and any failure in here, lets the call through.
import type { Register } from 'claude-code'

import { checkTitle as checkTitleCore } from '../core/naming.mjs'
import { check, namingProblem, parseJob as parseJobCore, refuse as refuseCore, refuseAll as refuseAllCore } from '../core/guard-rules.mjs'

export type Job = { id: string; role: 'dev' | 'tester' | 'other'; worktree: string; theirs: string[]; lib: string; libOwner: string; key?: string }
type Input = { command?: string; file_path?: string; notebook_path?: string }

export const parseJob = (prompt: string, subagentType: string): Job | null => parseJobCore(prompt, subagentType)
export const refuseAll = (job: Job, tool: string, input: Record<string, unknown>): string => refuseAllCore(job, tool, input)
export const refuse = (job: Job, tool: string, input: Input): string => refuseCore(job, tool, input)
export const checkTitle = (text: string, kind: 'commit' | 'pr', key = ''): string[] => checkTitleCore(text, { kind, key })
export { namingProblem }

export const guard: Register = on => {
  const jobs = new Map<string, Job>()

  on('agent.spawn', async (_, e, next) => {
    const started = await next(e)
    try {
      const job = parseJob(e.prompt || '', e.subagentType || '')
      if (job && started && started.agentId) jobs.set(started.agentId, job)
    } catch {
      // An unrecognised prompt: no guard for this agent.
    }
    return started
  })

  for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob'] as const) {
    on('tool.call', { tool }, ($, e, next) => {
      const job = e.agentId ? jobs.get(e.agentId) : undefined
      if (!job) return next(e)
      const why = check(job, tool, e as Record<string, unknown>)
      return why ? { deny: why } : next(e)
    }).catch((_, e, next) => next(e))
  }
}
