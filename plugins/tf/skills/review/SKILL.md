---
name: review
description: Review a team member's PR: e2e of the ticket's acceptance criteria with evidence, plus a risk report (risk, impact on other features, UI change, AC coverage, typecheck/build). No code changes; drafts only. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<PR url|ticket key> [@artifact…]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **review**
- input and flags: `$ARGUMENTS`
