#!/usr/bin/env node
// tf — Codex host: runs the engine with every job as `codex exec` (runtime/runner.mjs for the commands).
//   node <plugin>/hosts/codex/run.mjs start <task dir>/run-args.json
//   node <plugin>/hosts/codex/run.mjs wait <task dir>
import { fileURLToPath } from 'node:url'

import { isMain } from '../../core/main.mjs'
import { runnerCli } from '../../runtime/runner.mjs'
import { codexDriver } from './driver.mjs'

if (isMain(import.meta.url)) await runnerCli(fileURLToPath(import.meta.url), codexDriver)
