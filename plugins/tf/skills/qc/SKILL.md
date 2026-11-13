---
name: qc
description: "Answer a QC bug report on a ticket already done with tf - next round on the same folder, branches and saved e2e flows; fix, re-test, update the PR. Team PR reviews go to /tf:address-review. Workspace rules live in <workspace>/.claude/task-flow.md."
argument-hint: "<ticket key> [--draft] [--attach]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **qc**
- input and flags: `$ARGUMENTS`
