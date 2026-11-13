---
name: build
description: Run a new development task end to end with the SDC PM-led team (PM plans and staffs dev/tester/reviewer agents, ready PR + e2e evidence + ticket-comment draft). Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<ticket key|text> [--approve] [--draft] [--lang vi]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **build**
- input and flags: `$ARGUMENTS`
