---
name: qc
description: Answer a QC bug report (or human PR review points) on a ticket already done with tf: next round on the same folder, branches and saved e2e flows; fix, re-test, update the PR. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<ticket key> [--draft]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **qc**
- input and flags: `$ARGUMENTS`
