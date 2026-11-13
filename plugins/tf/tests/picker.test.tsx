import { expect, test } from 'claude-code/testing'

const LIST = [
  { id: 'aaaaaaaaaaaa', url: 'https://claude.ai/artifact/aaaaaaaaaaaa', title: 'Brand DS', kind: 'design system', reasons: ['created here'], last: '2026-11-13' },
  { id: 'bbbbbbbbbbbb', url: 'https://claude.ai/artifact/bbbbbbbbbbbb', title: 'Checkout redesign', kind: 'design', reasons: ['created here'], last: '2026-11-12' },
]

const BAND = {
  plugin: 'tf',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, scroll: { offset: 0, bodyRows: 20 } },
} as const

function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(LIST), stderr: '' } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context ?? [] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

// session.start loads the list in the background; let that settle.
const settle = () => new Promise(r => setTimeout(r, 20))

test('the band lists the workspace artifacts and attaches picked ones to the next message', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  await settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Button', key: 'tf-open' }))).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'tf-open' })
  await ui.press({ key: 'tf-aaaaaaaaaaaa' })
  await ui.unmount()

  const sent = await $.prompt.submit({ text: 'please review this' })
  expect(sent.text).toContain('https://claude.ai/artifact/aaaaaaaaaaaa')
  expect(sent.text).not.toContain('bbbbbbbbbbbb')

  const again = await $.prompt.submit({ text: 'next message' })
  expect(again.text).toBe('next message')
})

test('the list follows the session to its workspace after it started in another folder', async ($, on) => {
  const asked: string[] = []
  let root = '/spare'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: root }))
  on('process.run', (_, e) => {
    const dir = e.argv[e.argv.length - 1]
    asked.push(dir)
    return { value: { exitCode: 0, stdout: JSON.stringify(dir === '/ws' ? LIST : []), stderr: '' } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/spare', surface: 'desktop', isInteractive: true })
  await settle()
  expect(asked).toEqual(['/spare'])
  root = '/ws' // the host moved the session to the user's folder
  await $.turn.complete({ answer: 'done' })
  await settle()
  expect(asked).toEqual(['/spare', '/ws'])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'tf-open', text: /Artifacts \(2\)/ })).toBeTruthy()
  await ui.unmount()
})

test('an empty workspace still shows the band as Artifacts (0) with a hint', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context ?? [] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'tf-open' })).toBeTruthy()
  await ui.press({ key: 'tf-open' })
  expect(await ui.find({ type: 'Text', text: /No artifacts in this workspace yet/ })).toBeTruthy()
  await ui.press({ key: 'tf-close' })
  expect(await ui.find({ type: 'Button', key: 'tf-open' })).toBeTruthy()
  await ui.unmount()

  const sent = await $.prompt.submit({ text: 'hello' })
  expect(sent.text).toBe('hello')
})
