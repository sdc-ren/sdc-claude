// tf knowledge — what a map reads a repo from:
//   openRepo(repo, base)   its main branch on the remote (`origin/<base>`), so a map does not depend on which branch
//                          the checkout is on or on local edits; the working tree when there is no such ref
//   openAt(repo, rev)      one commit (the merge-base a task branched from, for a diff)
//   openWorktree(dir)      a task's worktree as it is now: tracked files, edits not committed, new files not tracked
// Every reader: { ref, version, files(), has(path), read(path), grep(regex, pathFilter) } — text comes back with
// '\n' line ends whatever the checkout uses, so line numbers are the same on every system.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const MAX_FILE = 2 << 20 // a source file larger than this (a bundle, generated code) is not read

const git = (repo, args, max = 64 << 20) => {
  try { return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', windowsHide: true, timeout: 120_000, maxBuffer: max }).toString() } catch { return null }
}
const lf = (s) => (s === null || s === undefined ? s : String(s).replace(/\r\n/g, '\n'))

// Folders never worth reading, whatever the repo: dependencies, builds, caches, tf's own task folders.
export const SKIP = /(^|\/)(node_modules|\.git|\.worktrees|\.pipeline|\.codegraph|dist|build|out|coverage|\.next|\.nuxt|\.output|\.dart_tool|\.gradle|Pods|vendor|target|__pycache__|\.venv|venv)(\/|$)/

/** The base branch of a repo: the given one, else origin/HEAD, else the first of main/develop/master on origin. */
export function baseOf(repo, given = '') {
  if (given) return given
  const head = git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  if (head && head.trim()) return head.trim().replace(/^origin\//, '')
  for (const b of ['main', 'develop', 'master']) if (git(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${b}`])) return b
  const cur = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return cur && cur.trim() !== 'HEAD' ? cur.trim() : ''
}

// git grep -E is POSIX ERE: no \s, \w, \d, \b (it reads \s as a plain "s"). The same pattern in POSIX classes.
export const toERE = (re) => String(re).replace(/\\s/g, '[[:space:]]').replace(/\\S/g, '[^[:space:]]').replace(/\\w/g, '[[:alnum:]_]').replace(/\\d/g, '[0-9]').replace(/\\b/g, '')

// Lines `file:line:text` of `git grep -n` → [{ file, line, text }] (the ref prefix taken off).
function parseGrep(out, refPrefix) {
  const hits = []
  for (const raw of (out || '').split('\n')) {
    const l = raw.replace(/\r$/, '') // a CRLF file: '.' in the regex below would stop at the '\r'
    if (!l) continue
    const s = refPrefix && l.startsWith(refPrefix) ? l.slice(refPrefix.length) : l
    const m = s.match(/^(.*?):(\d+):(.*)$/)
    if (m && !SKIP.test(m[1])) hits.push({ file: m[1], line: Number(m[2]), text: m[3] })
  }
  return hits
}

function atRev(repo, rev, label) {
  const version = (git(repo, ['rev-parse', rev]) || '').trim()
  let list = null
  const files = () => (list ||= (git(repo, ['ls-tree', '-r', '--name-only', rev]) || '').split('\n').filter((f) => f && !SKIP.test(f)))
  return {
    ref: label || rev, version, files,
    has: (p) => files().includes(p),
    read: (p) => lf(git(repo, ['show', `${rev}:${p}`], MAX_FILE)),
    grep: (re, filter = () => true) => parseGrep(git(repo, ['grep', '-n', '-I', '-E', '-e', toERE(re), rev, '--'], 256 << 20), `${rev}:`).filter((h) => filter(h.file)),
  }
}

function workingTree(dir, withUntracked) {
  let list = null
  const files = () => {
    if (list) return list
    const tracked = git(dir, ['ls-files'])
    if (tracked !== null) {
      const extra = withUntracked ? git(dir, ['ls-files', '--others', '--exclude-standard']) || '' : ''
      return (list = [...new Set(`${tracked}\n${extra}`.split('\n'))].filter((f) => f && !SKIP.test(f) && existsSync(join(dir, f))))
    }
    const out = []
    const walk = (d, depth) => {
      if (depth > 6 || out.length > 20000) return
      let names = []
      try { names = readdirSync(d) } catch { return }
      for (const n of names) {
        const p = join(d, n)
        const rel = relative(dir, p).split(sep).join('/')
        if (SKIP.test(rel)) continue
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) walk(p, depth + 1)
        else out.push(rel)
      }
    }
    walk(dir, 0)
    return (list = out)
  }
  const read = (p) => { try { const f = join(dir, p); return statSync(f).size > MAX_FILE ? null : lf(readFileSync(f, 'utf8')) } catch { return null } }
  const head = (git(dir, ['rev-parse', 'HEAD']) || '').trim()
  return {
    ref: 'working tree',
    version: head ? `worktree:${head}` : `worktree:${Date.now()}`,
    files,
    has: (p) => existsSync(join(dir, p)),
    read,
    // Every file of files() (untracked ones too): the same answer as git grep, without missing new files.
    grep: (re, filter = () => true) => {
      const rx = new RegExp(re)
      const hits = []
      for (const f of files()) {
        if (!filter(f)) continue
        const t = read(f)
        if (!t || !rx.test(t)) continue
        t.split('\n').forEach((text, i) => { if (rx.test(text)) hits.push({ file: f, line: i + 1, text }) })
      }
      return hits
    },
  }
}

/** A reader of one repo's main branch on the remote, or its working tree when there is none. */
export function openRepo(repo, base) {
  const ref = base && git(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${base}`]) ? `origin/${base}` : ''
  return ref ? atRev(repo, ref, ref) : workingTree(repo, false)
}

/** A reader of one commit of a repo (or of a worktree, which shares its repo's commits). */
export const openAt = (repo, rev, label) => atRev(repo, rev, label)

/** A reader of a task's worktree as it is now, edits and new files included. */
export const openWorktree = (dir) => workingTree(dir, true)
