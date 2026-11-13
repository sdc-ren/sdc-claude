---
name: regression
description: Run the workspace regression suite: e2e flows promoted from merged tickets (.pipeline/_regression/).
argument-hint: "[--target local|dev]"
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/flow-run.mjs <cwd>/.pipeline/_regression $ARGUMENTS` (default target `local`; Playwright package from the workspace config `## Flows`). Report PASS/FAIL per case with evidence files.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
