import { describe, expect, it } from 'vitest'
import { applyProposalEdits, isWithinProjectRoot, normalizeModelJson, validateExistingFileProposal, validateProposal } from './proposal'

describe('proposal validation', () => {
  it('accepts a valid proposal object', () => {
    const result = validateProposal({
      type: 'code_change_proposal',
      summary: 'Update helper logic',
      changes: [
        {
          file: 'src/helpers.ts',
          operation: 'replace',
          description: 'Fix the helper output',
          edits: [{ old_text: 'const value = 1', new_text: 'const value = 2' }],
        },
      ],
      notes: ['Safe update'],
    })

    expect(result.summary).toBe('Update helper logic')
    expect(result.changes).toHaveLength(1)
  })

  it('rejects a path traversal attempt', () => {
    expect(isWithinProjectRoot('/tmp/project', '../secret.txt')).toBe(false)
    expect(isWithinProjectRoot('/tmp/project', 'src/../other.txt')).toBe(false)
  })

  it('strips JSON code fences before validation', () => {
    const raw = '```json\n{"type":"code_change_proposal","summary":"Test","changes":[{"file":"src/test.ts","operation":"replace","description":"ok","edits":[{"old_text":"abc","new_text":"def"}]}]}\n```'
    const parsed = JSON.parse(normalizeModelJson(raw))
    expect(validateProposal(parsed).changes[0].edits?.[0].new_text).toBe('def')
  })

  it('extracts a JSON proposal surrounded by model commentary', () => {
    const raw = '**Updated the file:**\n{"type":"code_change_proposal","summary":"Test","changes":[{"file":"src/test.ts","operation":"replace","description":"ok","edits":[{"old_text":"const value = 1","new_text":"const text = \\"{value}\\""}]}]}\nDone.'
    const parsed = JSON.parse(normalizeModelJson(raw))
    expect(validateProposal(parsed).changes[0].edits?.[0].new_text).toBe('const text = "{value}"')
  })

  it('accepts replacement proposals only for files in the selected project', () => {
    const proposal = {
      type: 'code_change_proposal',
      summary: 'Update existing source',
      changes: [{
        file: 'src/main.py',
        operation: 'replace',
        description: 'Add the requested behavior',
        edits: [{ old_text: 'print("old")', new_text: 'print("updated")' }],
      }],
    }

    expect(validateExistingFileProposal(proposal, new Set(['src/main.py'])).changes[0].operation).toBe('replace')
    expect(() => validateExistingFileProposal(proposal, new Set(['other.py']))).toThrow(/does not exist/)
    expect(() => validateExistingFileProposal({
      ...proposal,
      changes: [{ ...proposal.changes[0], operation: 'create' }],
    }, new Set(['src/main.py']))).toThrow(/only edit existing files/)
  })

  it('applies exact text edits without dropping the rest of the file', () => {
    expect(applyProposalEdits('before\nold line\nafter\n', [
      { old_text: 'old line', new_text: 'new line' },
    ])).toBe('before\nnew line\nafter\n')
  })

  it('rejects missing or ambiguous edit targets', () => {
    expect(() => applyProposalEdits('first\nsecond\n', [{ old_text: 'missing', new_text: 'x' }])).toThrow(/Could not find/)
    expect(() => applyProposalEdits('same\nsame\n', [{ old_text: 'same', new_text: 'changed' }])).toThrow(/more than once/)
  })
})
