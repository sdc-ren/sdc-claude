// tf — tool guard. The rules an agent prompt can only ask for are refused here, at the tool call:
//   · a dev job (lead or member) never commits, pushes, merges or rebases — the reviewer packages;
//   · a team member never edits a file the lead gave to another member;
//   · a tester told the flow library is read-only (another tester of its group is the writer) never edits it.
// And for every tf agent, whatever its role (the PM included) — they read tickets, PR comments and pages other
// people wrote, so what such text could talk an agent into is refused here, not only in its prompt:
//   · the saved logins (~/.claude/task-flow/auth) are never read, listed, copied or edited — the scripts use them;
//   · nothing is merged, approved or force-pushed;
//   · nothing is posted (PR or ticket comment, review, reply): the orchestrator posts, after the user approved;
//   · a commit message (`git commit -m`) or PR title (`gh pr create|edit --title`) follows guidelines/git.md —
//     the task's issue key is the scope, never at the end or in brackets; a PR title is English.
// This narrows what a misled agent can do; it is not a sandbox — a command can be disguised. The rules are
// string checks in memory: no file read, no process, no model call per tool call.
// A job is recognised when the executor starts it (`agent.spawn`: the prompt begins "Job J<n> · role …") and
// its tool calls carry that agent's id; any other agent of this plugin (subagent type tf:…) gets the rules for
// every agent. Anything unrecognised, and any failure in here, lets the call through.
import type { Register } from 'claude-code'

export type Job = { id: string; role: 'dev' | 'tester' | 'other'; worktree: string; theirs: string[]; lib: string; libOwner: string; key?: string }

// Paths compare with forward slashes; a Windows path (drive letter) also ignores case.
const slash = (p: string) => { const s = p.replace(/\\/g, '/'); return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s }
const clean = (p: string) => slash(p.trim()).replace(/^\.\//, '')

export function parseJob(prompt: string, subagentType: string): Job | null {
  const head = prompt.match(/^Job (J\d+[a-c]?) · role ([a-z ]+)/)
  // The PM, the plan check: no job header, still a tf agent.
  if (!head) return /^tf[:-]/.test(subagentType) ? { id: subagentType, role: 'other', worktree: '', theirs: [], lib: '', libOwner: '' } : null
  const type = subagentType.replace(/^tf[:-]/, '')
  const role = type === 'dev' || type === 'lead' ? 'dev' : type === 'tester' ? 'tester' : 'other'
  const worktree = slash((prompt.match(/^Worktree: ((?:\/|[A-Za-z]:[\\/])\S+)/m) || [])[1] || '')
  const their = prompt.match(/Their files \(do not touch\): (.*?)\. Follow dev\.md/)
  const lib = prompt.match(/FLOW LIBRARY READ-ONLY: (J\d+) is the only job that may edit ((?:\/|[A-Za-z]:[\\/])\S+) in this group/)
  const task = (prompt.match(/^Task (\S+) · mode /m) || [])[1] || ''
  return {
    key: KEY.test(task) ? task : '',
    id: head[1],
    role,
    worktree,
    theirs: their ? their[1].split(', ').map(clean).filter(Boolean) : [],
    lib: lib ? slash(lib[2]).replace(/\/$/, '') : '',
    libOwner: lib ? lib[1] : '',
  }
}

// `git commit` and friends as a command (after `;`, `&&`, `|`, `(`, a newline or at the start), with any
// `-C <dir>` / `-c k=v` before the verb. The word inside a message, a path or an echo does not match.
const GIT_WRITE = /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:[A-Z_]+=\S+\s+)*git\b(?:\s+-[Cc]\s+\S+)*\s+(commit|push|merge|rebase|cherry-pick)\b/
const WRITES = /\bsed\s+(?:-\S*i|--in-place)|\b(?:rm|mv|tee|truncate)\b|>>?\s*\S/

// The saved logins, however the path is written (~, $HOME, an absolute path, either separator).
const AUTH = /task-flow[\\/]+auth(?![\w-])/i
const OUTWARD: [RegExp, string][] = [
  [/\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*\/(merge|merges|auto-merge)\b|\bgh\s+pr\s+review\b/, 'never merges, approves or reviews a PR on GitHub — a PR stops at its link, and the user decides'],
  [/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(--force(-with-lease|-if-includes)?\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+\S)/, 'never force-pushes — push a new commit, or report why the branch cannot be pushed'],
  [/\bgh\s+(pr|issue)\s+comment\b|pr-feedback\.mjs["']?\s+(post|reply|comment|review|resolve)\b|jira\.mjs["']?\s+comment\b[^\n;&|]*\s--confirm\b/, 'never posts a comment, a reply or a review — write the draft to the task folder; the orchestrator posts it after the user approved the text'],
]
// ── Naming (a copy of scripts/naming.mjs checkTitle: a hook module loads no script) ──────────────────
const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'style', 'chore']
const KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/
const ACCENTED = /[\u00C0-\u024F\u1E00-\u1EFF]/
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function checkTitle(text: string, kind: 'commit' | 'pr', key = ''): string[] {
  const line = String(text || '').split(/\r?\n/)[0].trim()
  const out: string[] = []
  const m = line.match(new RegExp(`^(${TYPES.join('|')})(?:\\(([^)]*)\\))?(!)?: (\\S.*)$`))
  if (!m) out.push(`not "<type>(${key || '<scope>'}): <summary>" — type one of ${TYPES.join(', ')}`)
  else {
    const scope = m[2] || ''
    const summary = m[4]
    if (key) {
      if (scope !== key) out.push(`the issue key is the scope: "${m[1]}(${key}): …"${scope ? `, not "(${scope})"` : ''}`)
      if (new RegExp(esc(key), 'i').test(summary)) out.push('the key appears in the summary too — it belongs in the parentheses only')
    } else if (scope && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope)) out.push(`scope "${scope}" is not lowercase kebab-case`)
    if (/\.$/.test(summary)) out.push('no trailing period')
  }
  if (/\[[A-Z][A-Z0-9]*-\d+\]/.test(line)) out.push('no [KEY] in brackets')
  if (kind === 'pr' && ACCENTED.test(line)) out.push('a PR title is English: no accented letters (write it for the PR, do not copy a commit in another language)')
  if (line.length > 100) out.push(`${line.length} characters — keep it to about 72`)
  return out
}
// The text of a quoted shell argument after a flag: "…", '…', or the first line of a "$(cat <<'EOF' … EOF)"
// heredoc. null when it cannot be read from the command (a variable, a file) — then it is not checked here.
function quotedAfter(cmd: string, flag: RegExp): string | null {
  const m = cmd.match(new RegExp(`(?:^|\\s)(?:${flag.source})(?:\\s+|=)("((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`))
  if (!m) return null
  const v = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]
  const here = v.match(/^\$\(cat <<-?'?(\w+)'?\n([^\n]*)/)
  if (here) return here[2]
  return /^\$/.test(v) ? null : v
}
const GIT_COMMIT = /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:[A-Z_]+=\S+\s+)*git\b(?:\s+-[Cc]\s+\S+)*\s+commit\b([^\n;&|]*)/
const GH_PR = /\bgh\s+pr\s+(create|edit)\b([^\n;&|]*)/
export function namingProblem(cmd: string, key = ''): string {
  const pr = cmd.match(GH_PR)
  if (pr) {
    const args = pr[2]
    if (pr[1] === 'create' && /\s--fill(-first|-verbose)?\b/.test(args) && !/\s(--title|-t)\b/.test(args))
      return 'writes the PR title itself — `--fill` copies a commit summary; pass `--title "<type>(<KEY>): <English summary>"` (guidelines/git.md)'
    const title = quotedAfter(cmd.slice((pr.index || 0) + pr[0].length - args.length), /--title|-t/)
    if (title !== null) {
      const bad = checkTitle(title, 'pr', key)
      if (bad.length) return `PR title "${title}" breaks guidelines/git.md: ${bad.join('; ')}`
    }
  }
  const c = cmd.match(GIT_COMMIT)
  if (c && !/--amend\b[^\n]*--no-edit/.test(c[1])) {
    // From `commit` to the end: a heredoc message spans lines.
    const msg = quotedAfter(cmd.slice((c.index || 0) + c[0].length - c[1].length), /-m|--message|-[a-zA-Z]*m/)
    if (msg !== null) {
      const bad = checkTitle(msg, 'commit', key)
      if (bad.length) return `commit message "${msg.split('\n')[0]}" breaks guidelines/git.md: ${bad.join('; ')}`
    }
  }
  return ''
}

const NO_AUTH = 'the saved logins in ~/.claude/task-flow/auth are never read, listed, copied or edited by an agent — open a signed-in browser with browser.mjs (openBrowser({ auth })) instead'

// What no tf agent does, whatever its role and whatever a ticket, a comment or a page told it.
export function refuseAll(job: Job, tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const cmd = String(input.command || '')
    if (AUTH.test(cmd)) return `tf: ${NO_AUTH}.`
    for (const [re, why] of OUTWARD) if (re.test(cmd)) return `tf: ${job.id} ${why}.`
    const naming = namingProblem(cmd, job.key || '')
    if (naming) return `tf: ${job.id} ${naming}. Check a message first: node <plugin>/scripts/naming.mjs check --kind commit|pr${job.key ? ` --key ${job.key}` : ''} "<line>".`
    return ''
  }
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'glob']) if (AUTH.test(String(input[k] || ''))) return `tf: ${NO_AUTH}.`
  return ''
}

export function refuse(job: Job, tool: string, input: { command?: string; file_path?: string; notebook_path?: string }): string {
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return ''
  if (tool === 'Bash') {
    const cmd = input.command || ''
    const flat = slash(cmd).toLowerCase()
    const git = job.role === 'dev' ? cmd.match(GIT_WRITE) : null
    if (git) return `tf: job ${job.id} is a dev job and never runs \`git ${git[1]}\` — leave the changes uncommitted; the reviewer commits and pushes after the tester passed.`
    // Git Bash also spells C:/Users/… as /c/Users/….
    const lib = job.lib.toLowerCase()
    if (job.lib && (flat.includes(lib) || flat.includes(lib.replace(/^([a-z]):/, '/$1'))) && WRITES.test(cmd))
      return `tf: the flow library ${job.lib} is read-only for job ${job.id} (${job.libOwner} is its writer in this group). Put the helper in <task>/flows/_new/${job.id}-<name>.mjs and list it under "library:".`
    return ''
  }
  const path = slash(input.file_path || input.notebook_path || '')
  if (!path) return ''
  if (job.lib && (path === job.lib || path.startsWith(`${job.lib}/`)))
    return `tf: the flow library is read-only for job ${job.id} (${job.libOwner} is its writer in this group). Write the helper to <task>/flows/_new/${job.id}-<name>.mjs instead.`
  if (job.theirs.length && job.worktree && path.startsWith(`${job.worktree}/`)) {
    const rel = path.slice(job.worktree.length + 1)
    if (job.theirs.some((f) => f === rel || f.toLowerCase() === rel)) return `tf: ${rel} belongs to another member of your team. Do not edit it: report the exact change under "blocked" and the lead applies it at merge.`
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

  for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob'] as const) {
    on('tool.call', { tool }, ($, e, next) => {
      const job = e.agentId ? jobs.get(e.agentId) : undefined
      if (!job) return next(e)
      const why = refuseAll(job, tool, e as Record<string, unknown>) || refuse(job, tool, e as { command?: string; file_path?: string; notebook_path?: string })
      return why ? { deny: why } : next(e)
    }).catch((_, e, next) => next(e))
  }
}
