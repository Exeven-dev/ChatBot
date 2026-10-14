export type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type FileNode = {
  name: string
  path: string
  kind: 'file' | 'dir'
  children?: FileNode[]
}

export type ProposalChange = {
  file: string
  operation: 'create' | 'replace' | 'delete'
  description: string
  edits?: ProposalEdit[]
  original_content?: string
  new_content?: string
  expected_hash?: string
  selected?: boolean
}

export type ProposalEdit = {
  old_text: string
  new_text: string
}

export type CodeChangeProposal = {
  type: 'code_change_proposal'
  summary: string
  changes: ProposalChange[]
  notes?: string[]
}

export type OllamaModel = {
  name: string
  size?: number
  modified_at?: string
}

export type ChatRequestMode = 'ask' | 'propose'
