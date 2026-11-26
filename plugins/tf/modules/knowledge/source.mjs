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

// Many files of one commit in one `git cat-file --batch` (a `git show` per file costs a process each).
function batchRead(repo, rev, paths) {
  const out = new Map()
  if (!paths.length) return out
  let buf
  try { buf = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: paths.map((p) => `${rev}:${p}`).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000, maxBuffer: 512 << 20 }) } catch { return out }
  let at = 0
  for (const p of paths) {
    const nl = buf.indexOf(10, at)
    if (nl < 0) break
    const head = buf.toString('utf8', at, nl)
    const m = head.match(/^\S+ (\w+) (\d+)$/)
    if (!m) { at = nl + 1; continue } // "<rev>:<path> missing"
    const size = Number(m[2])
    if (m[1] === 'blob' && size <= MAX_FILE) out.set(p, lf(buf.toString('utf8', nl + 1, nl + 1 + size)))
    at = nl + 1 + size + 1
  }
  return out
}

function atRev(repo, rev, label) {
  const version = (git(repo, ['rev-parse', rev]) || '').trim()
  let list = null
  const files = () => (list ||= (git(repo, ['ls-tree', '-r', '--name-only', rev]) || '').split('\n').filter((f) => f && !SKIP.test(f)))
  const cache = new Map()
  const read = (p) => { if (!cache.has(p)) cache.set(p, lf(git(repo, ['show', `${rev}:${p}`], MAX_FILE))); return cache.get(p) }
  return {
    ref: label || rev, version, files,
    has: (p) => files().includes(p),
    read,
    // Read many files at once into the cache; read() then answers from it.
    prefetch: (paths) => { const want = [...new Set(paths)].filter((p) => !cache.has(p)); for (const [p, t] of batchRead(repo, rev, want)) cache.set(p, t); for (const p of want) if (!cache.has(p)) cache.set(p, null) },
    grep: (re, filter = () => true) => parseGrep(git(repo, ['grep', '-n', '-I', '-E', '-e', toERE(re), rev, '--'], 256 << 20), `${rev}:`).filter((h) => filter(h.file)),
    // Lines holding any of many fixed strings (git's fixed-string search: far faster than a long alternation).
    grepWords: (words, filter = () => true, wholeWord = false) => (words.length ? parseGrep(git(repo, ['grep', '-n', '-I', '-F', ...(wholeWord ? ['-w'] : []), ...words.flatMap((w) => ['-e', w]), rev, '--'], 256 << 20), `${rev}:`).filter((h) => filter(h.file)) : []),
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
    prefetch: () => {},
    grepWords: (words, filter = () => true, wholeWord = false) => {
      if (!words.length) return []
      const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const rx = new RegExp(wholeWord ? `(?<![\\w$])(${esc.join('|')})(?![\\w$])` : `(${esc.join('|')})`)
      const hits = []
      for (const f of files()) {
        if (!filter(f)) continue
        const t = read(f)
        if (!t || !rx.test(t)) continue
        t.split('\n').forEach((text, i) => { if (rx.test(text)) hits.push({ file: f, line: i + 1, text }) })
      }
      return hits
    },
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
