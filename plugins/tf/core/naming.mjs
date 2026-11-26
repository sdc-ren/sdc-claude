// tf core — the naming rules of guidelines/git.md for a commit message's first line and a PR title.
// One copy for every caller: scripts/naming.mjs (the `check` command), the tool guard (core/guard-rules.mjs)
// and any host's hook.
//
// Hook-safe: no imports at all. A host's hook module may have no Node, so nothing here touches node:*.

export const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'style', 'chore']
// An issue key as trackers write it (PROJ-12, GH-WEB-9); a task slug that is one is the task's key.
export const KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/
/** @param {unknown} slug */
export const issueKey = (slug) => (KEY.test(String(slug || '')) ? String(slug) : '')
// Vietnamese and other accented Latin letters: a PR title is English.
const ACCENTED = /[À-ɏḀ-ỿ]/
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Problems with the first line of a commit message or a PR title ([] = fine).
 * @param {unknown} text
 * @param {{ kind?: 'commit' | 'pr', key?: string }} [opts]
 * @returns {string[]}
 */
export function checkTitle(text, { kind = 'commit', key = '' } = {}) {
  const line = String(text || '').split(/\r?\n/)[0].trim()
  const out = []
  const m = line.match(new RegExp(`^(${TYPES.join('|')})(?:\\(([^)]*)\\))?(!)?: (\\S.*)$`))
  if (!m) {
    out.push(`not "<type>(${key || '<scope>'}): <summary>" — type one of ${TYPES.join(', ')}`)
  } else {
    const scope = m[2] || ''
    const summary = m[4]
    if (key) {
      if (scope !== key) out.push(`the issue key is the scope: "${m[1]}(${key}): …"${scope ? `, not "(${scope})"` : ''}`)
      if (new RegExp(esc(key), 'i').test(summary)) out.push('the key appears in the summary too — it belongs in the parentheses only')
    } else if (scope && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope)) out.push(`scope "${scope}" is not lowercase kebab-case`)
    if (/\.$/.test(summary)) out.push('no trailing period')
  }
  if (/\[[A-Z][A-Z0-9]*-\d+\]/.test(line)) out.push('no [KEY] in brackets')
  if (kind === 'pr' && ACCENTED.test(line)) out.push('a PR title is English: no accented letters (write it for the PR, do not copy a commit in another language)')
  if (line.length > 100) out.push(`${line.length} characters — keep it to about 72`)
  return out
}
