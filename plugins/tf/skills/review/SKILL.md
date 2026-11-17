---
name: review
description: "Review a team member's PR by reading the code: logic against the ticket, impact on other parts (functions, variables, types, contracts and who uses them), security, standards, typecheck/build. Static and fast - nothing is run on the app; use /tf:e2e for that. No code changes; drafts only. Workspace rules live in <workspace>/.claude/task-flow.md."
argument-hint: "<PR url|ticket key> [--attach]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **review**
- input and flags: `$ARGUMENTS`
