---
name: attach
description: Pick Claude artifacts, canvases and design systems for a task from a checkbox list built automatically for this workspace (created here, used here before, or titled for it) — never other projects'. Saves them into the task folder for the PM, devs and testers.
argument-hint: "<ticket> [keyword]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`. Input: `$ARGUMENTS`.

1. Resolve the task folder: `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs resolve <cwd> "<ticket>"` → use its
   `dir` and `slug`.
2. Follow `${CLAUDE_PLUGIN_ROOT}/docs/attach.md` exactly; remaining words are the title keyword filter.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
