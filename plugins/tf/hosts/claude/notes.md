Host notes (Claude Code) — how the *(host: …)* steps of tf's docs are done here:
- **ask**: `AskUserQuestion`, at most 4 questions per call (several calls when there are more), the recommended option first.
- **open a file**: `mcp__ccd_host__open_in_editor` when available.
- **session title**: `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` (load it via ToolSearch if deferred; missing → skip).
- **attachments**: `{{root}}/hosts/claude/docs/attach.md` (artifacts, canvases and design systems; `--attach` runs its Picker).
- **run the executor**: the `Workflow` tool with `scriptPath: <the script task.mjs engine wrote>` and the args; the user watches it in `/workflows`. `agentPrefix`: `"tf:"`.
- **metrics**: `node {{root}}/scripts/metrics.mjs <cwd> <slug> --last`.
- **background**: Bash with `run_in_background`.
