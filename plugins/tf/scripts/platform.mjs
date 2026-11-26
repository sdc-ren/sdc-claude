#!/usr/bin/env node
// tf — the old entry point of the platform layer, kept so every script, prompt and saved command that names
// scripts/platform.mjs keeps working. The code moved:
//   core/platform.mjs           macOS / Linux / Windows differences (processes, ports, shells, files)
//   core/paths.mjs              tf's state folder and workspace config file
//   hosts/claude/transcripts.mjs  Claude Code's data folder and transcripts
//
//   node platform.mjs info | kill <pid> | free-port <port>   (see core/platform.mjs)
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { info as coreInfo, main } from '../core/platform.mjs'
import { claudeDir } from '../hosts/claude/transcripts.mjs'

export * from '../core/platform.mjs'
export { stateDir } from '../core/paths.mjs'
export { claudeDir, projectDirName, projectDirs, projectMatch } from '../hosts/claude/transcripts.mjs'

// What this machine offers, with the Claude Code data folder doctor reports.
export const info = () => ({ ...coreInfo(), claudeDir: claudeDir() })

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2), info)
