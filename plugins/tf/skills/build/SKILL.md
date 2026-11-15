---
name: build
description: Run a new development task end to end with the SDC PM-led team (PM plans and staffs dev/tester/reviewer agents, ready PR + e2e evidence + ticket-comment draft when a tracker issue is the source). Input is anything - an issue key, any link (tracker, doc, Notion, Figma, web page, claude.ai artifact, canvas, design system), a file path, or plain words. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<key | link(s) | words> [--approve] [--draft] [--lang vi] [--attach]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **build**
- input and flags: `$ARGUMENTS`
