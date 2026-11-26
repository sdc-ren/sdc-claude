// tf — Claude Code host: where Claude Code keeps its data and transcripts. Used by the artifact index
// (scripts/artifacts-local.mjs) and run metrics (scripts/metrics.mjs). Another host keeps its own equivalent
// in hosts/<agent>/; the shared code never reads ~/.claude itself.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { stateDir } from '../../core/paths.mjs'
import { under } from '../../core/platform.mjs'

// Claude Code keeps its data in ~/.claude on every system unless CLAUDE_CONFIG_DIR moves it.
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
// The transcript folder of a working directory: every character that is not a letter or digit becomes "-".
export const projectDirName = (cwd) => resolve(String(cwd)).replace(/[^A-Za-z0-9]/g, '-')

// Does a folder under <claude>/projects belong to this workspace (the folder itself or a sub-folder of it)?
// Claude Code shortens names over 200 characters and appends a hash, so long names are matched by prefix.
export const projectMatch = (enc) => (enc.length > 180 ? (d) => d.startsWith(enc.slice(0, 180)) : (d) => d === enc || d.startsWith(`${enc}-`))

// The folder a transcript folder was started from, read from its transcripts (their first "cwd"). '' when
// none says. The name alone cannot tell: every character that is not a letter or digit became "-", so
// /work/app-private and /work/app/private share the name prefix of /work/app.
function startedIn(dir) {
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) } catch {}
  for (const f of files.slice(0, 5)) {
    let fd
    try {
      fd = openSync(f, 'r')
      const buf = Buffer.alloc(1 << 16)
      let carry = ''
      for (let read = 0, n; read < 8 << 20 && (n = readSync(fd, buf, 0, buf.length, null)) > 0; read += n) {
        const text = carry + buf.toString('utf8', 0, n)
        const m = text.match(/"cwd":("(?:[^"\\\\]|\\\\.)*")/)
        if (m) { try { return JSON.parse(m[1]) } catch {} }
        carry = text.slice(-512)
      }
    } catch {} finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
  }
  return ''
}
// The transcript folders of a workspace: its own, and those of sessions started in a sub-folder of it. A
// folder that only shares the name prefix is taken when its transcripts say so, and left out otherwise —
// another project's sessions are never listed here. Each answer is remembered (a folder's start never changes).
export function projectDirs(root) {
  const base = join(claudeDir(), 'projects')
  const enc = projectDirName(root)
  let names = []
  try { names = readdirSync(base).filter(projectMatch(enc)) } catch {}
  if (enc.length > 180 || names.every((d) => d === enc)) return names.map((d) => join(base, d))
  const memo = join(stateDir(), 'project-dirs.json')
  let seen = {}
  try { seen = JSON.parse(readFileSync(memo, 'utf8')) } catch {}
  let dirty = false
  const out = []
  for (const d of names) {
    const dir = join(base, d)
    if (d === enc) { out.push(dir); continue }
    if (seen[dir] === undefined) { const cwd = startedIn(dir); if (cwd) { seen[dir] = cwd; dirty = true } }
    if (seen[dir] && under(seen[dir], resolve(root))) out.push(dir)
  }
  if (dirty) try { mkdirSync(stateDir(), { recursive: true }); writeFileSync(memo, JSON.stringify(seen)) } catch {}
  return out
}
