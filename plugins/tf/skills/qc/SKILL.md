---
name: qc
description: "Answer a QC bug report on a ticket already done with tf - next round on the same folder, branches and saved e2e flows; fix, re-test, update the PR. Team PR reviews go to /tf:address-review. Workspace rules live in <workspace>/.claude/task-flow.md."
argument-hint: "<task: key, link, slug> [--draft] [--attach]"
disable-model-invocation: true
---

Not in Claude Code? When the plugin root and the input below still read as variables, `<PLUGIN>` is the folder that holds this file's `skills/` folder, the input is what the user wrote with the command, and the host notes are `<PLUGIN>/hosts/<agent>/notes.md` for the agent you run in (`codex`, `copilot`), not the Claude Code ones.

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **qc**
- input and flags: `$ARGUMENTS`

Host notes (Claude Code) — how the *(host: …)* steps of tf's docs are done here:
- **ask**: `AskUserQuestion`, at most 4 questions per call (several calls when there are more), the recommended option first.
- **open a file**: `mcp__ccd_host__open_in_editor` when available.
- **session title**: `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` (load it via ToolSearch if deferred; missing → skip).
- **attachments**: `${CLAUDE_PLUGIN_ROOT}/hosts/claude/docs/attach.md` (artifacts, canvases and design systems; `--attach` runs its Picker).
- **run the executor**: the `Workflow` tool with `scriptPath: <the script task.mjs engine wrote>` and the args; the user watches it in `/workflows`. `agentPrefix`: `"tf:"`.
- **metrics**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs <cwd> <slug> --last`.
- **background**: Bash with `run_in_background`.
