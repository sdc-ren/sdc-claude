---
name: attach
description: Pick Claude artifacts and design systems for a task from a checkbox list — only the ones registered for this workspace (or matching its keywords), never other projects'. Saves them into the task folder for the PM, devs and testers. `--setup` registers which artifacts belong to this workspace.
argument-hint: "[ticket] [keyword] [--setup]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`. Input: `$ARGUMENTS`.

1. If a ticket key or PR URL is given, resolve the task folder first:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs resolve <cwd> "<ticket>"` → use its `dir` and `slug`.
   No ticket → registry only (step 5 of the procedure, skip steps 6–7).
2. Follow `${CLAUDE_PLUGIN_ROOT}/docs/attach.md` exactly, with the remaining words as the keyword filter
   and `--setup` if present.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
