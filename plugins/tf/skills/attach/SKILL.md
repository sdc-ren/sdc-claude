---
name: attach
description: Pick this workspace's Claude artifacts, canvases and design systems for a task from a checkbox list — found automatically (created in this workspace's sessions or attached to its tasks), never other projects'. Saves them into the task folder for the PM, devs and testers.
argument-hint: "<ticket> [keyword]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`. Input: `$ARGUMENTS`.

1. Resolve the task folder: `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs resolve <cwd> "<ticket>"` → `dir`, `slug`.
2. Follow the "Picker" section of `${CLAUDE_PLUGIN_ROOT}/docs/attach.md`; remaining words filter by title.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
