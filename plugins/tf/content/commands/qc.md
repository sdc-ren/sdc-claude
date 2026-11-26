---
name: qc
description: "Answer a QC bug report on a ticket already done with tf - next round on the same folder, branches and saved e2e flows; fix, re-test, update the PR. Team PR reviews go to /tf:address-review. Workspace rules live in <workspace>/{{config}}."
args: "<task: key, link, slug> [--draft] [--attach]"
user-only: true
---

{{fallback}}

Plugin root `<PLUGIN>` = `{{root}}`.

Read `{{root}}/docs/orchestrator.md` and follow it exactly, with:
- mode: **qc**
- input and flags: `{{args}}`

{{notes}}
