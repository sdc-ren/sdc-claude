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

const SHOWN = 12
const short = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const nameOf = (a: TfArtifact) => a.title || `Artifact ${a.id.slice(0, 8)}`

// Re-read the workspace's artifacts (cached by the script, ~50 ms after the first run).
async function refresh($: EngineInterface, cwd: string) {
  if (!cwd) return
  try {
    const script = `${$.plugin.root}/scripts/artifacts-local.mjs`
    const { exitCode, stdout } = await $.process.run(['node', script, cwd], { timeoutMs: 60_000 })
    if (exitCode !== 0) return
    const list = JSON.parse(stdout) as TfArtifact[]
    await update($, artifacts, () => list)
    await update($, picked, ids => ids.filter(id => list.some(a => a.id === id)))
  } catch {
    // No node, no transcripts, bad output: the band simply stays empty.
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
    const list = await read($, artifacts)
    if (!list.length) return next(e)
    const ids = await read($, picked)
    const open = await read($, isOpen)
    const { Box, Button, Text } = $.ui.resolve(e)
    const toggle = (id: string) => () => update($, picked, cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))

    if (!open) {
      return (
        <Box flexDirection="row" gap={1}>
          <Button key="tf-open" plain onPress={() => update($, isOpen, () => true)}>
            Artifacts ({list.length}){ids.length ? <Text color="green"> · {ids.length} picked</Text> : ''}
          </Button>
        </Box>
      )
    }

    const CANVAS = ['design', 'whiteboard']
    const designs = list.filter(a => a.kind === 'design system').slice(0, SHOWN)
    const canvases = list.filter(a => CANVAS.includes(a.kind)).slice(0, SHOWN)
    const others = list.filter(a => a.kind !== 'design system' && !CANVAS.includes(a.kind)).slice(0, SHOWN)
    // Compact chips drawn by the band itself: a light pill (Box background) holding a plain Button, so the
    // text colour is ours to set — native buttons ignore it. Picked = check + the theme's success green.
    const isTerminal = e.surface === 'terminal'
    const chip = (a: TfArtifact, showKind: boolean) => {
      const isPicked = ids.includes(a.id)
      const button = (
        <Button key={`tf-${a.id}`} plain onPress={toggle(a.id)}>
          <Text color={isPicked ? 'success' : undefined} bold={isPicked}>
            {isPicked ? '✓ ' : ''}{short(nameOf(a))}
          </Text>
          {showKind ? <Text dimColor> · {a.kind}</Text> : ''}
        </Button>
      )
      if (isTerminal) return button
      return (
        <Box key={`tf-pill-${a.id}`} backgroundColor="inactive" paddingX={1}>
          {button}
        </Box>
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
