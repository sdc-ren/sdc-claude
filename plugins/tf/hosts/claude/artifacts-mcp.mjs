#!/usr/bin/env node
// tf artifacts MCP server — puts this workspace's Claude artifacts, canvases and design systems into the
// `@` mention list of Claude Code (MCP resources). Only items that belong to the workspace are listed
// (created in its sessions, attached to its tasks, or pinned in its config) — see artifacts-local.mjs.
// Mentioning one in a /tf:* command attaches it to the task.
// Minimal MCP over stdio (JSON-RPC 2.0, one JSON message per line); no dependencies.
import { createInterface } from 'node:readline'
import { workspaceArtifacts } from './artifacts-local.mjs'

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const VERSION = '1.1.0'
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
const label = (x) => x.title || `Artifact ${x.id.slice(0, 8)}`
const day = (iso) => (iso ? String(iso).slice(0, 10) : '')

function list() {
  return workspaceArtifacts(ROOT).map((x) => ({
    uri: `artifact://${x.id}`,
    name: label(x),
    title: label(x),
    description: `${x.kind} · ${x.reasons.join(', ')}${x.last ? ` · ${day(x.last)}` : ''}`,
    mimeType: 'text/markdown',
  }))
}

function read(uri) {
  const id = String(uri).replace(/^artifact:\/\//, '')
  const x = workspaceArtifacts(ROOT).find((a) => a.id === id)
  if (!x) return null
  const kind = x.kind === 'design system' ? 'design-system' : 'artifact'
  return {
    contents: [{
      uri,
      mimeType: 'text/markdown',
      text: [
        `# ${label(x)}`,
        '',
        `- URL: ${x.url}`,
        `- Kind: ${kind} (${x.kind})`,
        `- Belongs to this workspace: ${x.reasons.join(', ')}`,
        '',
        'This is a reference to a Claude artifact. Load its content with the Artifact tool (`action: "read"`,',
        `\`url: "${x.url}"\`). In a /tf:* command, a mentioned artifact is attached to the task (saved to`,
        '`.pipeline/<TICKET>/specs/` and recorded in attachments.json); a design system binds UI work.',
      ].join('\n'),
    }],
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (!m || m.id === undefined) return // notifications
  try {
    switch (m.method) {
      case 'initialize':
        return reply(m.id, {
          protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
          capabilities: { resources: { listChanged: false } },
          serverInfo: { name: 'tf-artifacts', version: VERSION },
          instructions: 'Resources are the Claude artifacts and design systems of the current workspace. A resource mentioned in a /tf:* command is attached to that task.',
        })
      case 'ping': return reply(m.id, {})
      case 'resources/list': return reply(m.id, { resources: list() })
      case 'resources/templates/list': return reply(m.id, { resourceTemplates: [] })
      case 'resources/read': {
        const r = read(m.params && m.params.uri)
        return r ? reply(m.id, r) : fail(m.id, -32002, 'Resource not found in this workspace')
      }
      case 'tools/list': return reply(m.id, { tools: [] })
      case 'prompts/list': return reply(m.id, { prompts: [] })
      default: return fail(m.id, -32601, `Method not found: ${m.method}`)
    }
  } catch (e) {
    return fail(m.id, -32603, String(e && e.message || e))
  }
})
