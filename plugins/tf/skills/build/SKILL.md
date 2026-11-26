---
name: build
description: Run a new development task end to end with the SDC PM-led team (PM plans and staffs dev/tester/reviewer agents, ready PR + e2e evidence + ticket-comment draft when a tracker issue is the source). Input is anything - an issue key, any link (tracker, doc, Notion, Figma, web page, claude.ai artifact, canvas, design system), a file path, or plain words. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<key | link(s) | words> [--approve] [--assume] [--draft] [--lang vi] [--attach]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **build**
- input and flags: `$ARGUMENTS`

Host notes (Claude Code) — how the *(host: …)* steps of tf's docs are done here:
- **ask**: `AskUserQuestion`, at most 4 questions per call (several calls when there are more), the recommended option first.
- **open a file**: `mcp__ccd_host__open_in_editor` when available.
- **session title**: `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` (load it via ToolSearch if deferred; missing → skip).
- **attachments**: `${CLAUDE_PLUGIN_ROOT}/hosts/claude/docs/attach.md` (artifacts, canvases and design systems; `--attach` runs its Picker).
- **run the executor**: the `Workflow` tool with `scriptPath: <the script task.mjs engine wrote>` and the args; the user watches it in `/workflows`. `agentPrefix`: `"tf:"`.
- **metrics**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs <cwd> <slug> --last`.
- **background**: Bash with `run_in_background`.
