---
name: doctor
description: Check that this machine and workspace can run the tf plugin: tools, gh login, plugin agents and guidelines, workspace config, repos, Playwright, and the config Doctor checks.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs <cwd>` and report the result in the user's language: what passed, what failed, and how to fix each failure.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
