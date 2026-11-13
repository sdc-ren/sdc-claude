export type TfArtifact = {
  id: string
  url: string
  title: string
  kind: string
  reasons: string[]
  last: string
}

declare module 'claude-code' {
  interface PluginState {
    tf: {
      artifacts: Shaped<TfArtifact[]>
      picked: string[]
      isOpen: boolean
    }
  }
}
