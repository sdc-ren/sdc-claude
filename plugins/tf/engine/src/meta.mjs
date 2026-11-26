// tf engine — the workflow's name and phases, as a pure literal: a host that lists scripts by name reads it
// without running anything. task.mjs `engine` rewrites `name` per task.
export const meta = {
  name: 'task-flow',
  description: 'PM-led task pipeline: PM plans and dispatches dev/tester/reviewer jobs until the task closes',
  whenToUse: 'Internal engine of /tf:build, /tf:qc, /tf:address-review, /tf:review, /tf:e2e — launched by those skills with args; do not run it directly.',
  phases: [
    { title: 'PM', detail: 'tf:pm reads the task, plans (the plan is checked once by tf:reviewer on M/L tasks), dispatches, reviews reports, closes' },
    { title: 'Jobs', detail: 'setup / dev (lead + members) / tester / reviewer jobs from the PM dispatch, parallel per group' },
  ],
}

