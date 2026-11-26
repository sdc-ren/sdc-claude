---
name: demo
description: Turn a Claude Design canvas into a clickable demo to show a client — every screen of the canvas with its buttons, tabs, toggles and links working, grouped by role, run locally or published as one artifact, with a Feedback button on every screen. No repo, no PR, no agents.
argument-hint: "<canvas link> [what to show] [--publish] [--feedback <email|form link>] [--comments] [--name N] [--lang vi] [--attach]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/hosts/claude/docs/demo.md` and follow it exactly, with input and flags: `$ARGUMENTS`.
