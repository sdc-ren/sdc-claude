---
name: init
description: Set a workspace up for tf, or connect one that already has its own setup - detect the repos (one or several), their stacks, commands, docs and code-index tools; write or extend the workspace config ({{config}}); create or connect the knowledge maps the PM reads before the code; propose indexing repos that have no codegraph index. Shows what it will write and asks once.
args: "[--dry-run] [--yes] [--from <config file>] [--refresh]"
user-only: true
---

{{fallback}}

Plugin root `<PLUGIN>` = `{{root}}`.

Read `{{root}}/docs/init.md` and follow it exactly, with input and flags: `{{args}}`.

{{notes}}
