import { describe, expect, it, vi } from 'vitest'

import {
  buildSystemInstruction,
  DEFAULT_GUIDANCE,
  SAFETY_RULES,
} from '../../supabase/functions/_shared/assistant'
import {
  loadClinicPrompt,
  type PromptStore,
} from '../../supabase/functions/_shared/clinic-prompt'

/**
 * chatbot-reply's prompt lookup (migration 31): each clinic's own guidance,
 * found from the patient's doctor, and the built-in guidance - never another
 * clinic's - when it cannot be read.
 */

const CLINICS: Record<string, string> = {
  'doc-harborview': 'clinic-harborview',
  'doc-west': 'clinic-west',
}
const PROMPTS: Record<string, string> = {
  'clinic-harborview': 'Harborview guidance',
  'clinic-west': 'Western guidance',
}

function store(overrides: Partial<PromptStore> = {}): PromptStore {
  return {
    clinicOfDoctor: vi.fn(async (docId: string) => CLINICS[docId] ?? null),
    clinicPrompt: vi.fn(async (clinicId: string) => PROMPTS[clinicId] ?? null),
    ...overrides,
  }
}

describe('the chatbot prompt for a conversation', () => {
  it('is the patient’s own clinic’s, found through their doctor', async () => {
    const s = store()
    expect(await loadClinicPrompt(s, 'doc-harborview')).toBe('Harborview guidance')
    expect(await loadClinicPrompt(s, 'doc-west')).toBe('Western guidance')
    expect(s.clinicPrompt).toHaveBeenNthCalledWith(1, 'clinic-harborview')
    expect(s.clinicPrompt).toHaveBeenNthCalledWith(2, 'clinic-west')
  })

  it('is the built-in guidance when the clinic has written none', async () => {
    const s = store({ clinicPrompt: vi.fn(async () => null) })
    const prompt = await loadClinicPrompt(s, 'doc-west')
    expect(prompt).toBeNull()
    expect(buildSystemInstruction(prompt)).toBe(`${DEFAULT_GUIDANCE}\n${SAFETY_RULES}`)
  })

  it('is the built-in guidance, not another clinic’s, when the clinic is unknown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const s = store()
    expect(await loadClinicPrompt(s, 'doc-nobody')).toBeNull()
    expect(s.clinicPrompt).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it.each([
    ['the doctor', { clinicOfDoctor: vi.fn(async () => { throw new Error('column doctor.clinic_id does not exist') }) }],
    ['the prompt', { clinicPrompt: vi.fn(async () => { throw new Error('column system_setting.clinic_id does not exist') }) }],
  ])('is the built-in guidance when %s cannot be read, as before migration 31', async (_label, overrides) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await loadClinicPrompt(store(overrides as Partial<PromptStore>), 'doc-harborview')).toBeNull()
    // Logged for the operator, without the clinic or the doctor.
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toMatch(/built-in guidance/)
    expect(logged).not.toMatch(/clinic-harborview|doc-harborview/)
    error.mockRestore()
  })

  it('always ends with the safety rules, whichever guidance it starts with', () => {
    expect(buildSystemInstruction('Harborview guidance')).toBe(`Harborview guidance\n${SAFETY_RULES}`)
  })
})
