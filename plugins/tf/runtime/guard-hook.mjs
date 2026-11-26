#!/usr/bin/env node
// tf runtime — the tool guard as a command hook, for hosts whose hooks run a command before a tool call
// (Codex `PreToolUse`, Copilot `preToolUse`). The rules are core/guard-rules.mjs; this file only reads the
// host's hook input and answers in its format.
//
// Which job is calling comes from TF_JOB (set by runtime/process.mjs for the job's process). Without it — the
// user's own session, any other agent — every call is let through, as the in-process guard does.
//
//   stdin: the hook input (JSON). Codex / Claude-style: { tool_name, tool_input }. Copilot: { toolName, toolArgs }.
//   allow: exit 0, nothing printed. deny: the reason on stdout as the host's JSON and on stderr, exit 2.
import { check } from '../core/guard-rules.mjs'
import { isMain } from '../core/main.mjs'

// A host's tool name → the guard's canonical one ('' = not guarded).
export function canonicalTool(name) {
  const n = String(name || '')
  if (/^(bash|shell|powershell|execute|exec_command|local_shell|run_shell_command)$/i.test(n)) return 'Bash'
  if (/^(apply_patch|edit|multiedit|str_replace|str_replace_editor|replace)$/i.test(n)) return 'Edit'
  if (/^(write|create|write_file)$/i.test(n)) return 'Write'
  if (/^(read|view|read_file)$/i.test(n)) return 'Read'
  if (/^(grep|glob|search)$/i.test(n)) return 'Grep'
  return ''
}

// The files an apply_patch body touches ("*** Update File: path", "*** Add File: …", "*** Delete File: …").
const patchFiles = (text) => [...String(text || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim())

/**
 * The calls one hook input stands for, in the guard's terms. A patch over several files is one call per file.
 * @returns {{ tool: string, input: Record<string, unknown> }[]}
 */
export function callsOf(hookInput) {
  const h = hookInput || {}
  const name = h.tool_name ?? h.toolName ?? ''
  let args = h.tool_input ?? h.toolArgs ?? {}
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { command: args } } }
  const tool = canonicalTool(name)
  if (!tool) return []
  if (/^apply_patch$/i.test(name)) {
    const body = args.command ?? args.input ?? args.patch ?? ''
    const files = patchFiles(Array.isArray(body) ? body.join('\n') : body)
    return files.map((f) => ({ tool: 'Edit', input: { file_path: f } }))
  }
  const path = args.file_path ?? args.path ?? args.filePath ?? args.notebook_path
  const command = Array.isArray(args.command) ? args.command.join(' ') : args.command ?? args.cmd
  return [{ tool, input: { ...args, ...(path !== undefined ? { file_path: String(path) } : {}), ...(command !== undefined ? { command: String(command) } : {}) } }]
}

/** The reason to deny this hook input for this job, or ''. */
export function decide(job, hookInput) {
  if (!job) return ''
  for (const c of callsOf(hookInput)) {
    // A relative path is relative to where the agent runs.
    const p = c.input.file_path
    if (typeof p === 'string' && p && !/^(\/|[A-Za-z]:[\\/])/.test(p) && hookInput.cwd) c.input.file_path = `${String(hookInput.cwd).replace(/[\\/]$/, '')}/${p}`
    const why = check(job, c.tool, c.input)
    if (why) return why
  }
  return ''
}

// The deny answer in the shape the host reads (Codex and Claude-style hooks nest it; Copilot does not).
export const denyOutput = (hookInput, why) =>
  hookInput && ('toolName' in hookInput || 'toolArgs' in hookInput)
    ? { permissionDecision: 'deny', permissionDecisionReason: why }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }

async function main() {
  let job = null
  try { job = process.env.TF_JOB ? JSON.parse(process.env.TF_JOB) : null } catch {}
  if (!job) return
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input = {}
  try { input = JSON.parse(raw || '{}') } catch { return } // unreadable input: let it through, like the in-process guard
  const why = decide(job, input)
  if (!why) return
  process.stdout.write(JSON.stringify(denyOutput(input, why)))
  process.stderr.write(`${why}\n`)
  process.exitCode = 2
}

if (isMain(import.meta.url)) await main()
