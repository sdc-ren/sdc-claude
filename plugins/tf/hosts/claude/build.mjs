#!/usr/bin/env node
// tf — Claude Code host build: writes the files Claude Code reads, from the shared sources.
//   engine/task-flow.js        the Workflow script (engine/src/ bundled; Workflow gives the runtime as globals)
//   skills/<name>/SKILL.md     the /tf:<name> commands (content/commands/, and hosts/claude/commands/: Claude-only)
//   agents/<role>.md           the subagents tf:<role> (content/roles/ + hosts/claude/roles.json)
//
//   node hosts/claude/build.mjs           write what changed
//   node hosts/claude/build.mjs --check   exit 1 when a generated file differs from its sources (CI)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_ROOT, isMain } from '../../core/main.mjs'
import { bundleEngine } from '../../build/engine-bundle.mjs'
import { fill, frontMatter, load } from '../../build/render.mjs'
import { cli } from '../../build/write.mjs'

const BANNER = `// GENERATED from engine/src/ by hosts/claude/build.mjs — edit the sources, then run: node hosts/claude/build.mjs
// Claude Code's Workflow tool runs this file: it gives args, agent, parallel, phase, log and budget as globals.
`
// What the shared placeholders are in Claude Code: it substitutes ${CLAUDE_PLUGIN_ROOT} and $ARGUMENTS itself.
const BASE = { root: '${CLAUDE_PLUGIN_ROOT}', args: '$ARGUMENTS', config: '.claude/task-flow.md', roles: '${CLAUDE_PLUGIN_ROOT}/agents', background: '`run_in_background`' }
const NOTES = fill(readFileSync(join(PLUGIN_ROOT, 'hosts', 'claude', 'notes.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, ''), BASE)
// The shared skills/ folder is read by every agent that installs this plugin (Codex and Copilot read Claude
// Code's layout); only Claude Code fills the placeholders, so each command says what to do when they were not.
const FALLBACK = "Not in Claude Code? When the plugin root and the input below still read as variables, `<PLUGIN>` is the folder that holds this file's `skills/` folder, the input is what the user wrote with the command, and the host notes are `<PLUGIN>/hosts/<agent>/notes.md` for the agent you run in (`codex`, `copilot`), not the Claude Code ones."
export const VARS = { ...BASE, notes: NOTES, fallback: FALLBACK }
// Shared front matter keys → Claude Code's.
const COMMAND_KEYS = { name: 'name', description: 'description', args: 'argument-hint', 'user-only': 'disable-model-invocation' }
const ROLES = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hosts', 'claude', 'roles.json'), 'utf8'))

function skill({ name, meta, order, body }) {
  const pairs = order.map((k) => {
    if (!COMMAND_KEYS[k]) throw new Error(`content/commands/${name}.md: no Claude Code key for "${k}"`)
    return [COMMAND_KEYS[k], fill(meta[k], VARS)]
  })
  return frontMatter(pairs) + fill(body, VARS)
}

function agent({ name, meta, body }) {
  const host = ROLES[name]
  if (!host) throw new Error(`hosts/claude/roles.json has no entry for role ${name}`)
  return frontMatter([['name', meta.name], ['description', fill(meta.description, VARS)], ['tools', host.tools], ['model', host.model]]) + fill(body, VARS)
}

export function files() {
  const out = { 'engine/task-flow.js': bundleEngine(BANNER) }
  // Shared commands, plus the ones only Claude Code has (they read claude.ai artifacts or drive Claude in Chrome).
  for (const c of [...load('content/commands'), ...load('hosts/claude/commands')]) out[`skills/${c.name}/SKILL.md`] = skill(c)
  for (const r of load('content/roles')) out[`agents/${r.name}.md`] = agent(r)
  return out
}

if (isMain(import.meta.url)) cli('claude', files())
