---
name: address-review
description: Handle the team's review on PRs we pushed with tf - fetch unresolved review threads, reviews and comments, triage each point (fix / discuss / answered / out-of-scope), fix only what needs fixing on the same PR branch, and draft a reply per thread (posted after approval). --check stops after the triage. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<ticket key|PR url> [--check] [--lang vi]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **feedback**
- input and flags: `$ARGUMENTS`
