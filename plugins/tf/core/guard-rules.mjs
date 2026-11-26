// tf core — tool guard rules. The rules an agent prompt can only ask for, refused at the tool call:
//   · a dev job (lead or member) never commits, pushes, merges or rebases — the reviewer packages;
//   · a team member never edits a file the lead gave to another member;
//   · a tester told the flow library is read-only (another tester of its group is the writer) never edits it.
// And for every tf agent, whatever its role (the PM included) — they read tickets, PR comments and pages other
// people wrote, so what such text could talk an agent into is refused here, not only in its prompt:
//   · the saved logins (<tf state dir>/auth) are never read, listed, copied or edited — the scripts use them;
//   · nothing is merged, approved or force-pushed;
//   · nothing is posted (PR or ticket comment, review, reply): the orchestrator posts, after the user approved;
//   · a commit message (`git commit -m`) or PR title (`gh pr create|edit --title`) follows guidelines/git.md —
//     the task's issue key is the scope, never at the end or in brackets; a PR title is English.
// This narrows what a misled agent can do; it is not a sandbox — a command can be disguised. The rules are
// string checks in memory: no file read, no process, no model call per tool call.
//
// Pure and host-neutral: a host wires these into its own hook (tool name and input in, a reason to deny out).
// Tool names are the canonical ones (Bash, Edit, Write, NotebookEdit, Read, Grep, Glob); a host whose tools are
// named otherwise maps them first. Hook-safe: imports only core/naming.mjs, which imports nothing.

import { KEY, checkTitle } from './naming.mjs'

/**
 * A job as the executor started it.
 * @typedef {{ id: string, role: 'dev' | 'tester' | 'other', worktree: string, theirs: string[], lib: string, libOwner: string, key?: string }} Job
 */

// Paths compare with forward slashes; a Windows path (drive letter) also ignores case.
/** @param {string} p */
const slash = (p) => { const s = p.replace(/\\/g, '/'); return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s }
/** @param {string} p */
const clean = (p) => slash(p.trim()).replace(/^\.\//, '')

/**
 * The job of an agent, read from the prompt the executor started it with ("Job J<n> · role …").
 * A tf agent without a job header (the PM, the plan check) still gets the rules for every agent.
 * @param {string} prompt
 * @param {string} agentType the agent's type as the host names it (`tf:dev`, `tf-dev`, …)
 * @returns {Job | null}
 */
export function parseJob(prompt, agentType) {
  const head = prompt.match(/^Job (J\d+[a-c]?) · role ([a-z ]+)/)
  if (!head) return /^tf[:-]/.test(agentType) ? { id: agentType, role: 'other', worktree: '', theirs: [], lib: '', libOwner: '' } : null
  const type = agentType.replace(/^tf[:-]/, '')
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

// The saved logins, however the path is written (~, $HOME, an absolute path, either separator), in the
// legacy state folder (…/task-flow/auth) or the host-neutral one (~/.tf/auth, see core/paths.mjs).
const AUTH = /(?:task-flow|\.tf)[\\/]+auth(?![\w-])/i
/** @type {[RegExp, string][]} */
const OUTWARD = [
  [/\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*\/(merge|merges|auto-merge)\b|\bgh\s+pr\s+review\b/, 'never merges, approves or reviews a PR on GitHub — a PR stops at its link, and the user decides'],
  [/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(--force(-with-lease|-if-includes)?\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+\S)/, 'never force-pushes — push a new commit, or report why the branch cannot be pushed'],
  [/\bgh\s+(pr|issue)\s+comment\b|pr-feedback\.mjs["']?\s+(post|reply|comment|review|resolve)\b|jira\.mjs["']?\s+comment\b[^\n;&|]*\s--confirm\b/, 'never posts a comment, a reply or a review — write the draft to the task folder; the orchestrator posts it after the user approved the text'],
]

// The text of a quoted shell argument after a flag: "…", '…', or the first line of a "$(cat <<'EOF' … EOF)"
// heredoc. null when it cannot be read from the command (a variable, a file) — then it is not checked here.
/** @param {string} cmd @param {RegExp} flag @returns {string | null} */
function quotedAfter(cmd, flag) {
  const m = cmd.match(new RegExp(`(?:^|\\s)(?:${flag.source})(?:\\s+|=)("((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`))
  if (!m) return null
  const v = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]
  const here = v.match(/^\$\(cat <<-?'?(\w+)'?\n([^\n]*)/)
  if (here) return here[2]
  return /^\$/.test(v) ? null : v
}
const GIT_COMMIT = /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:[A-Z_]+=\S+\s+)*git\b(?:\s+-[Cc]\s+\S+)*\s+commit\b([^\n;&|]*)/
const GH_PR = /\bgh\s+pr\s+(create|edit)\b([^\n;&|]*)/

/**
 * Why a `git commit -m` message or a `gh pr create|edit --title` breaks guidelines/git.md ('' = fine).
 * @param {string} cmd
 * @param {string} [key]
 */
export function namingProblem(cmd, key = '') {
  const pr = cmd.match(GH_PR)
  if (pr) {
    const args = pr[2]
    if (pr[1] === 'create' && /\s--fill(-first|-verbose)?\b/.test(args) && !/\s(--title|-t)\b/.test(args))
      return 'writes the PR title itself — `--fill` copies a commit summary; pass `--title "<type>(<KEY>): <English summary>"` (guidelines/git.md)'
    const title = quotedAfter(cmd.slice((pr.index || 0) + pr[0].length - args.length), /--title|-t/)
    if (title !== null) {
      const bad = checkTitle(title, { kind: 'pr', key })
      if (bad.length) return `PR title "${title}" breaks guidelines/git.md: ${bad.join('; ')}`
    }
  }
  const c = cmd.match(GIT_COMMIT)
  if (c && !/--amend\b[^\n]*--no-edit/.test(c[1])) {
    // From `commit` to the end: a heredoc message spans lines.
    const msg = quotedAfter(cmd.slice((c.index || 0) + c[0].length - c[1].length), /-m|--message|-[a-zA-Z]*m/)
    if (msg !== null) {
      const bad = checkTitle(msg, { kind: 'commit', key })
      if (bad.length) return `commit message "${msg.split('\n')[0]}" breaks guidelines/git.md: ${bad.join('; ')}`
    }
  }
  return ''
}

const NO_AUTH = 'the saved logins in ~/.claude/task-flow/auth are never read, listed, copied or edited by an agent — open a signed-in browser with browser.mjs (openBrowser({ auth })) instead'

/**
 * What no tf agent does, whatever its role and whatever a ticket, a comment or a page told it.
 * @param {Job} job
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {string} the reason to deny, or ''
 */
export function refuseAll(job, tool, input) {
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

/**
 * What this job's role may not do.
 * @param {Job} job
 * @param {string} tool
 * @param {{ command?: string, file_path?: string, notebook_path?: string }} input
 * @returns {string} the reason to deny, or ''
 */
export function refuse(job, tool, input) {
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

/**
 * Both checks in the order the guard applies them.
 * @param {Job} job
 * @param {string} tool
 * @param {Record<string, unknown>} input
 */
export const check = (job, tool, input) => refuseAll(job, tool, input) || refuse(job, tool, input)
