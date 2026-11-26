#!/usr/bin/env node
// tf — the command line of the shared code: `tf <command> [args…]`, with the commands of cli/commands.mjs.
// A host's own entry point (hosts/<agent>/tf.mjs) adds that host's commands.
import { COMMANDS } from './commands.mjs'
import { run } from './run.mjs'

await run(process.argv.slice(2), COMMANDS)
