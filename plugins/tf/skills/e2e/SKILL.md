---
name: e2e
description: Run e2e only for a ticket or PR. The PM writes the test cases (cases.md) and stops; the user edits and approves them; then exactly those cases run — saved flows that still match re-run without any agent, the tester writes or fixes the rest. Evidence marks each bug (red box and label), plus a ticket-comment draft in the QC layout. No code changes. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<PR url|task> [--cases TC1,TC2] [--target local|dev] [--assume] [--attach] | --regression [--target local|dev]"
disable-model-invocation: true
---

Not in Claude Code? When the plugin root and the input below still read as variables, `<PLUGIN>` is the folder that holds this file's `skills/` folder, the input is what the user wrote with the command, and the host notes are `<PLUGIN>/hosts/<agent>/notes.md` for the agent you run in (`codex`, `copilot`), not the Claude Code ones.

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator-e2e.md` and follow them exactly, with:
- mode: **e2e** — section 2e (orchestrator-e2e.md) decides between the test-case gate, the fast path and a tester run
- input and flags: `$ARGUMENTS` (`--assume`: approve the PM's cases without asking; `--target`: the target to run on)

`--regression` instead of a ticket: no workflow — run the workspace regression suite (flows promoted from
merged tickets): `node ${CLAUDE_PLUGIN_ROOT}/scripts/flow-run.mjs <cwd>/.pipeline/_regression --target <t>`
(default `local`; Playwright package from the workspace config `## Flows`) and report PASS/FAIL per case.

Host notes (Claude Code) — how the *(host: …)* steps of tf's docs are done here:
- **ask**: `AskUserQuestion`, at most 4 questions per call (several calls when there are more), the recommended option first.
- **open a file**: `mcp__ccd_host__open_in_editor` when available.
- **session title**: `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` (load it via ToolSearch if deferred; missing → skip).
- **attachments**: `${CLAUDE_PLUGIN_ROOT}/hosts/claude/docs/attach.md` (artifacts, canvases and design systems; `--attach` runs its Picker).
- **run the executor**: the `Workflow` tool with `scriptPath: <the script task.mjs engine wrote>` and the args; the user watches it in `/workflows`. `agentPrefix`: `"tf:"`.
- **metrics**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs <cwd> <slug> --last`.
- **background**: Bash with `run_in_background`.
