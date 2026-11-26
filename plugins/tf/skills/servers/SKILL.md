---
name: servers
description: Show the dev servers tf tasks run in this workspace (port, task, whether they run the worktree's current code, ones started by hand from a task worktree) and stop the ones the user picks.
argument-hint: "[<slug>] [--all]"
disable-model-invocation: true
---

Not in Claude Code? When the plugin root and the input below still read as variables, `<PLUGIN>` is the folder that holds this file's `skills/` folder, the input is what the user wrote with the command, and the host notes are `<PLUGIN>/hosts/<agent>/notes.md` for the agent you run in (`codex`, `copilot`), not the Claude Code ones.

Input: `$ARGUMENTS`. `<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/serve.mjs list <cwd>` — show the table as it prints. With a `<slug>`, keep only that
   task's rows. Columns: `code` is `current` (runs the worktree's code now), `STALE` (the code changed since it
   started) or `?` (unknown: started by hand, or before tf recorded versions); `started by` is `serve.mjs` or
   `by hand: <command>`. Nothing listed → say so and stop.
2. Ask which to stop *(host: ask)*, several at once allowed. One option per row (`#<n> <task> <server or
   pid> :<port>`); with more rows than one question holds, offer the groups instead — every stopped record, every
   `STALE` / `?` server, one option per task, everything — and let the user name rows by `#`. `--all` means
   everything: still show the table and ask once for a yes. Never stop anything without the user's choice.
3. For each chosen row:
   - started by `serve.mjs` → `node ${CLAUDE_PLUGIN_ROOT}/scripts/serve.mjs stop <cwd> <task> <server>` (a `stopped` row
     only clears its record);
   - by hand → `node ${CLAUDE_PLUGIN_ROOT}/scripts/serve.mjs stop <cwd> <task> --pid <pid>` (stops it only when it runs from
     that task's worktree).
   Each prints one JSON line: report `stopped` / `gone` per row, and quote any `error` with its reason.
4. Run step 1 again and show the table, so the user sees what is left. A task whose run is still going starts
   its servers again on its next `serve.mjs start` — say so in one line when the user stopped one of its servers.

Reply in the user's language.
