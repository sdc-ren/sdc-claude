// tf — tool guard. The rules an agent prompt can only ask for are refused here, at the tool call:
//   · a dev job (lead or member) never commits, pushes, merges or rebases — the reviewer packages;
//   · a team member never edits a file the lead gave to another member;
//   · a tester told the flow library is read-only (another tester of its group is the writer) never edits it.
// A job is recognised when the executor starts it (`agent.spawn`: the prompt begins "Job J<n> · role …") and
// its tool calls carry that agent's id. Anything unrecognised, and any failure in here, lets the call through.
import type { Register } from 'claude-code'

export type Job = { id: string; role: 'dev' | 'tester' | 'other'; worktree: string; theirs: string[]; lib: string; libOwner: string }

const clean = (p: string) => p.trim().replace(/^\.\//, '')

export function parseJob(prompt: string, subagentType: string): Job | null {
  const head = prompt.match(/^Job (J\d+[a-c]?) · role ([a-z ]+)/)
  if (!head) return null
  const type = subagentType.replace(/^tf[:-]/, '')
  const role = type === 'dev' || type === 'lead' ? 'dev' : type === 'tester' ? 'tester' : 'other'
  const worktree = (prompt.match(/^Worktree: (\/\S+)/m) || [])[1] || ''
  const their = prompt.match(/Their files \(do not touch\): (.*?)\. Follow dev\.md/)
  const lib = prompt.match(/FLOW LIBRARY READ-ONLY: (J\d+) is the only job that may edit (\/\S+) in this group/)
  return {
    id: head[1],
    role,
    worktree,
    theirs: their ? their[1].split(', ').map(clean).filter(Boolean) : [],
    lib: lib ? lib[2].replace(/\/$/, '') : '',
    libOwner: lib ? lib[1] : '',
  }
}

// `git commit` and friends as a command (after `;`, `&&`, `|`, `(`, a newline or at the start), with any
// `-C <dir>` / `-c k=v` before the verb. The word inside a message, a path or an echo does not match.
const GIT_WRITE = /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:[A-Z_]+=\S+\s+)*git\b(?:\s+-[Cc]\s+\S+)*\s+(commit|push|merge|rebase|cherry-pick)\b/
const WRITES = /\bsed\s+(?:-\S*i|--in-place)|\b(?:rm|mv|tee|truncate)\b|>>?\s*\S/

export function refuse(job: Job, tool: string, input: { command?: string; file_path?: string; notebook_path?: string }): string {
  if (tool === 'Bash') {
    const cmd = input.command || ''
    const git = job.role === 'dev' ? cmd.match(GIT_WRITE) : null
    if (git) return `tf: job ${job.id} is a dev job and never runs \`git ${git[1]}\` — leave the changes uncommitted; the reviewer commits and pushes after the tester passed.`
    if (job.lib && cmd.includes(job.lib) && WRITES.test(cmd))
      return `tf: the flow library ${job.lib} is read-only for job ${job.id} (${job.libOwner} is its writer in this group). Put the helper in <task>/flows/_new/${job.id}-<name>.mjs and list it under "library:".`
    return ''
  }
  const path = input.file_path || input.notebook_path || ''
  if (!path) return ''
  if (job.lib && (path === job.lib || path.startsWith(`${job.lib}/`)))
    return `tf: the flow library is read-only for job ${job.id} (${job.libOwner} is its writer in this group). Write the helper to <task>/flows/_new/${job.id}-<name>.mjs instead.`
  if (job.theirs.length && job.worktree && path.startsWith(`${job.worktree}/`)) {
    const rel = path.slice(job.worktree.length + 1)
    if (job.theirs.includes(rel)) return `tf: ${rel} belongs to another member of your team. Do not edit it: report the exact change under "blocked" and the lead applies it at merge.`
  }
  return ''
}

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

  for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit'] as const) {
    on('tool.call', { tool }, ($, e, next) => {
      const job = e.agentId ? jobs.get(e.agentId) : undefined
      if (!job) return next(e)
      const why = refuse(job, tool, e as { command?: string; file_path?: string; notebook_path?: string })
      return why ? { deny: why } : next(e)
    }).catch((_, e, next) => next(e))
  }
}
