export type AgentAttachment = {
  token: string
  name: string
  ext: string
  size: number
  previewPath?: string
}

export type AgentHistoryRecord = {
  id: string
  createdAt: string
  instruction: string
  kind: string
  outputs: string[]
  summary: string
}

export type DocumentCapabilities = {
  modelConfigured: boolean
  modelLocal: boolean
  providerName: string
  model: string
}

export type SuggestedAction = {
  label: string
  text: string
}

export type PendingTaskKind = 'doc' | 'analysis' | 'outcome' | 'cross-qa' | 'download' | 'link-analysis' | 'batch' | 'compress' | 'trim' | 'video-gen' | 'dedup' | 'recut'
