// tf — artifact picker above the prompt.
// A band above the chat input lists this workspace's Claude artifacts, canvases and design systems
// (found by scripts/artifacts-local.mjs: created in this workspace's sessions, attached to its tasks,
// or pinned in its config). Press one to pick it; picked items are appended as links to the next
// message you send, e.g. `/tf:build PROJ-12`, which then attaches them to the task.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TfArtifact } from '../types'

const artifacts = atom({ plugin: 'tf', key: 'artifacts' } as const, [] as TfArtifact[], { shape: 'artifacts-1' })
const picked = atom({ plugin: 'tf', key: 'picked' } as const, [] as string[])
const isOpen = atom({ plugin: 'tf', key: 'isOpen' } as const, false)
const problem = atom({ plugin: 'tf', key: 'problem' } as const, '')

const SHOWN = 12
const short = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const nameOf = (a: TfArtifact) => a.title || `Artifact ${a.id.slice(0, 8)}`

// Re-read the workspace's artifacts (cached by the script, ~50 ms after the first run).
// The workspace is asked for on every refresh, never remembered from session.start: the desktop app starts
// a session in a pre-warmed spare folder and moves it to the user's folder afterwards, so the directory
// seen at start is often not the workspace — the list then stayed empty for the whole session.
async function refresh($: EngineInterface, startCwd: string) {
  let root = startCwd
  try {
    root = (await $.session.root()) || startCwd
  } catch {
    // An engine without session.root: fall back to where the session started.
  }
  if (!root) return
  try {
    const script = `${$.plugin.root}/scripts/artifacts-local.mjs`
    const { exitCode, stdout, stderr } = await $.process.run(['node', script, root], { timeoutMs: 60_000 })
    if (exitCode !== 0) throw new Error((stderr || `exit ${exitCode}`).trim().split('\n').pop())
    const list = JSON.parse(stdout) as TfArtifact[]
    await update($, artifacts, () => list)
    await update($, picked, ids => ids.filter(id => list.some(a => a.id === id)))
    await update($, problem, () => '')
  } catch (err) {
    // No node, bad output: keep the last list and say so in the band instead of looking empty.
    await update($, problem, () => String((err as Error)?.message || err).slice(0, 120))
  }
}

export const register: Register = on => {
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const started = await next(e)
    void refresh($, cwd)
    return started
  })

  // New artifacts made during the session show up after the turn that made them.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($, cwd)
    return done
  })

  // Picked items ride along with the next message as plain links, which /tf:* commands attach.
  on('prompt.submit', async ($, e, next) => {
    const ids = await read($, picked)
    if (!ids.length || e.isMeta) return next(e)
    const list = await read($, artifacts)
    const chosen = list.filter(a => ids.includes(a.id))
    if (!chosen.length) return next(e)
    const links = chosen.map(a => a.url).join(' ')
    const note = chosen.map(a => `${nameOf(a)} (${a.kind}) — ${a.url}`).join('\n')
    await update($, picked, () => [])
    await update($, isOpen, () => false)
    if (e.command) {
      const args = `${e.command.args} ${links}`.trim()
      return next({ ...e, command: { ...e.command, args }, text: `${e.text} ${links}` })
    }
    return next({ ...e, text: `${e.text}\n\nAttached artifacts:\n${note}` })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Always drawn, even when empty: an empty workspace shows "Artifacts (0)" so it is not mistaken for a
    // band that failed to load (e.g. after switching account).
    const list = await read($, artifacts)
    const ids = await read($, picked)
    const open = await read($, isOpen)
    const failed = await read($, problem)
    const { Box, Button, Text } = $.ui.resolve(e)
    const toggle = (id: string) => () => update($, picked, cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))

    if (!open) {
      return (
        <Box flexDirection="row" gap={1}>
          <Button key="tf-open" plain onPress={() => update($, isOpen, () => true)}>
            Artifacts ({list.length}){ids.length ? <Text color="green"> · {ids.length} picked</Text> : ''}
            {failed ? <Text color="yellow"> · could not list</Text> : ''}
          </Button>
        </Box>
      )
    }

    if (!list.length) {
      return (
        <Box flexDirection="column" gap={1}>
          {failed ? <Text color="yellow">Could not list this workspace's artifacts: {failed}</Text> : ''}
          <Text dimColor>
            No artifacts in this workspace yet. They appear here once published from a session in this folder,
            attached to a task, or pinned as the design system in .claude/task-flow.md. You can also paste a
            claude.ai/artifact link into the command.
          </Text>
          <Box flexDirection="row">
            <Button key="tf-close" role="dismiss" plain onPress={() => update($, isOpen, () => false)}>Close</Button>
          </Box>
        </Box>
      )
    }

    const CANVAS = ['design', 'whiteboard']
    const designs = list.filter(a => a.kind === 'design system').slice(0, SHOWN)
    const canvases = list.filter(a => CANVAS.includes(a.kind)).slice(0, SHOWN)
    const others = list.filter(a => a.kind !== 'design system' && !CANVAS.includes(a.kind)).slice(0, SHOWN)
    // Native chips (the desktop app draws its own button and ignores text colours inside it).
    // Picked: check mark at full strength; not picked: dimmed label. No filled background.
    const chip = (a: TfArtifact, showKind: boolean) => {
      const isPicked = ids.includes(a.id)
      return (
        <Button key={`tf-${a.id}`} variant="secondary" dimColor={!isPicked} onPress={toggle(a.id)}>
          {isPicked ? '✓ ' : ''}{short(nameOf(a))}
          {showKind ? <Text dimColor> · {a.kind}</Text> : ''}
        </Button>
      )
    }
    const section = (title: string, items: TfArtifact[], showKind: boolean) =>
      items.length > 0 && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>{title}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {items.map(a => chip(a, showKind))}
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        {section('Design system', designs, false)}
        {section('Artifacts', others, true)}
        {section('Canvases', canvases, true)}
        <Box flexDirection="row" gap={2}>
          <Text dimColor>
            {ids.length ? `${ids.length} picked · sent with your next message` : 'Pick, then send e.g. /tf:build PROJ-12'}
          </Text>
          {ids.length > 0 && <Button key="tf-clear" plain onPress={() => update($, picked, () => [])}>Clear</Button>}
          <Button key="tf-close" role="dismiss" plain onPress={() => update($, isOpen, () => false)}>Close</Button>
        </Box>
      </Box>
    )
  })
}
