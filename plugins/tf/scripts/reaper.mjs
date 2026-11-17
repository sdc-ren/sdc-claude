#!/usr/bin/env node
// tf no longer installs a background cleanup job: cleanup happens only when the user runs /tf:clean.
// This script is what is left of the old reaper — it removes the job a version before 1.16.0 installed.
//
//   node reaper.mjs status       prints installed | not installed (exit 0 | 1)
//   node reaper.mjs uninstall    macOS: launchd agent · Linux: systemd user timer or cron entry ·
//                                Windows: Task Scheduler task; also deletes ~/.claude/task-flow/reaper/

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OS, stateDir, which } from './platform.mjs'

const LABEL = 'ai.claude.task-flow-reap'
const NAME = 'task-flow-reap'
const DIR = join(stateDir(), 'reaper')
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const UNIT_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
const CRON_MARK = `# ${NAME}`

const run = (file, args, input) => execFileSync(file, args, { stdio: ['pipe', 'pipe', 'pipe'], input, windowsHide: true }).toString()
const quiet = (file, args, input) => { try { return { ok: true, out: run(file, args, input) } } catch (e) { return { ok: false, out: String(e.stderr || e.message) } } }
const hasSystemd = () => !!which('systemctl') && quiet('systemctl', ['--user', 'show-environment']).ok

const jobs = {
  macos: {
    status: () => quiet('launchctl', ['list', LABEL]).ok,
    uninstall() { quiet('launchctl', ['unload', PLIST]); rmSync(PLIST, { force: true }) },
  },
  linux: {
    status: () => (hasSystemd() && quiet('systemctl', ['--user', 'is-enabled', `${NAME}.timer`]).ok) || (!!which('crontab') && quiet('crontab', ['-l']).out.includes(CRON_MARK)),
    uninstall() {
      if (hasSystemd()) { quiet('systemctl', ['--user', 'disable', '--now', `${NAME}.timer`]); for (const u of ['service', 'timer']) rmSync(join(UNIT_DIR, `${NAME}.${u}`), { force: true }); quiet('systemctl', ['--user', 'daemon-reload']) }
      if (which('crontab')) { const cur = quiet('crontab', ['-l']); if (cur.ok && cur.out.includes(CRON_MARK)) quiet('crontab', ['-'], cur.out.split('\n').filter((l) => !l.includes(CRON_MARK)).join('\n')) }
    },
  },
  windows: {
    status: () => quiet('schtasks', ['/Query', '/TN', NAME]).ok,
    uninstall() { quiet('schtasks', ['/Delete', '/F', '/TN', NAME]) },
  },
}

export const reaperInstalled = () => { try { return !!jobs[OS].status() } catch { return false } }

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const cmd = process.argv[2]
  const it = jobs[OS]
  try {
    if (cmd === 'uninstall') { it.uninstall(); rmSync(DIR, { recursive: true, force: true }); console.log(`removed ${NAME}`) }
    else if (cmd === 'status') { const on = reaperInstalled(); console.log(on ? 'installed' : 'not installed'); process.exit(on ? 0 : 1) }
    else { console.error('usage: reaper.mjs status | uninstall'); process.exit(2) }
  } catch (e) {
    console.error(`reaper ${cmd} failed: ${String(e.stderr || e.message || e).trim().split('\n')[0]}`)
    process.exit(1)
  }
}
