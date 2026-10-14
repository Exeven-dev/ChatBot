import { z } from 'zod'
import type { CodeChangeProposal, ProposalChange, ProposalEdit } from '../types'

const proposalEditSchema = z.object({
  old_text: z.string().min(1),
  new_text: z.string(),
})

const proposalChangeSchema = z.object({
  file: z.string().refine((value) => {
    if (!value || value.startsWith('/') || value.startsWith('\\')) return false
    if (value.includes('..')) return false
    return true
  }, 'Invalid relative file path.'),
  operation: z.enum(['create', 'replace', 'delete']),
  description: z.string().min(1),
  edits: z.array(proposalEditSchema).optional(),
  original_content: z.string().optional(),
  new_content: z.string().optional(),
  expected_hash: z.string().optional(),
})

export const proposalSchema = z.object({
  type: z.literal('code_change_proposal'),
  summary: z.string().min(1),
  changes: z.array(proposalChangeSchema).min(1),
  notes: z.array(z.string()).optional(),
})

export const proposalOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'summary', 'changes'],
  properties: {
    type: { type: 'string', const: 'code_change_proposal' },
    summary: { type: 'string', minLength: 1 },
    changes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'operation', 'description', 'edits'],
        properties: {
          file: { type: 'string', minLength: 1 },
          operation: { type: 'string', const: 'replace' },
          description: { type: 'string', minLength: 1 },
          edits: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['old_text', 'new_text'],
              properties: {
                old_text: { type: 'string', minLength: 1 },
                new_text: { type: 'string' },
              },
            },
          },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
} satisfies Record<string, unknown>

export function normalizeModelJson(raw: string): string {
  let cleaned = raw.trim()
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim()
  }

  const start = cleaned.indexOf('{')
  if (start === -1) return cleaned

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < cleaned.length; index += 1) {
    const character = cleaned[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, index + 1)
    }
  }

  return cleaned
}

export function validateProposal(raw: unknown): CodeChangeProposal {
  const parsed = proposalSchema.parse(raw) as CodeChangeProposal

  for (const change of parsed.changes) {
    if (change.operation === 'replace' && !change.edits?.length) {
      throw new Error(`Replacement for ${change.file} is missing text edits.`)
    }
  }

  return parsed
}

export function applyProposalEdits(original: string, edits: ProposalEdit[]): string {
  let updated = original
  for (const edit of edits) {
    const start = updated.indexOf(edit.old_text)
    if (start === -1) {
      throw new Error(`Could not find the requested original text in the file:\n${edit.old_text}`)
    }
    if (updated.indexOf(edit.old_text, start + edit.old_text.length) !== -1) {
      throw new Error(`The requested original text appears more than once; refusing an ambiguous edit:\n${edit.old_text}`)
    }
    updated = `${updated.slice(0, start)}${edit.new_text}${updated.slice(start + edit.old_text.length)}`
  }
  if (updated === original) {
    throw new Error('The proposed edits do not change the file.')
  }
  return updated
}

export function validateExistingFileProposal(raw: unknown, existingFiles: ReadonlySet<string>): CodeChangeProposal {
  const parsed = validateProposal(raw)
  const seenFiles = new Set<string>()

  for (const change of parsed.changes) {
    if (change.operation !== 'replace') {
      throw new Error('Proposals may only edit existing files; creating or deleting files is not allowed.')
    }
    if (!existingFiles.has(change.file)) {
      throw new Error(`The proposed file does not exist in the selected project: ${change.file}`)
    }
    if (seenFiles.has(change.file)) {
      throw new Error(`The proposal contains duplicate changes for ${change.file}.`)
    }
    seenFiles.add(change.file)
  }

  return parsed
}

export function buildDiff(oldText: string, newText: string) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  const max = Math.max(oldLines.length, newLines.length)
  const lines: { type: 'added' | 'removed' | 'unchanged'; value: string }[] = []

  for (let i = 0; i < max; i += 1) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]

    if (oldLine === newLine) {
      lines.push({ type: 'unchanged', value: newLine ?? '' })
      continue
    }

    if (oldLine !== undefined) {
      lines.push({ type: 'removed', value: oldLine })
    }
    if (newLine !== undefined) {
      lines.push({ type: 'added', value: newLine })
    }
  }

  return lines
}

export function isWithinProjectRoot(rootPath: string, relativePath: string) {
  const sanitized = relativePath.replace(/\\/g, '/')
  if (!sanitized || sanitized.startsWith('/') || sanitized.includes('..')) {
    return false
  }

  const absolute = sanitizePath(rootPath, sanitized)
  return absolute.startsWith(rootPath.replace(/\\/g, '/'))
}

export function sanitizePath(rootPath: string, relativePath: string) {
  const normalizedRoot = rootPath.replace(/\\/g, '/')
  const safe = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const joined = `${normalizedRoot.replace(/\/$/, '')}/${safe.join('/')}`
  return joined.replace(/\/+/g, '/')
}

export function getSerializableProposal(raw: object): CodeChangeProposal {
  const parsed = proposalSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join(', '))
  }

  return parsed.data as CodeChangeProposal
}

export function defaultProposalChange(): ProposalChange {
  return {
    file: '',
    operation: 'replace',
    description: '',
    original_content: '',
    new_content: '',
    selected: true,
  }
}
