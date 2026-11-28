#!/usr/bin/env node
// tf — Claude Code host: `tf <command> [args…]` with the shared commands and the ones that read Claude Code's
// own data (artifacts, transcripts) or check this plugin's Claude setup.
import { COMMANDS } from '../../cli/commands.mjs'
import { run } from '../../cli/run.mjs'

export const CLAUDE_COMMANDS = {
  ...COMMANDS,
  doctor: 'hosts/claude/doctor.mjs',
  metrics: 'hosts/claude/metrics.mjs',
  rules: 'hosts/claude/rules.mjs',
  'artifacts-local': 'hosts/claude/artifacts-local.mjs',
}

await run(process.argv.slice(2), CLAUDE_COMMANDS)
