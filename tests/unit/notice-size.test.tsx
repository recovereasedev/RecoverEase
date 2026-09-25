import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Notice } from '@/components/ui/notice'

/**
 * Notice body text (audit L1). Supporting notices stay a step below the page's
 * body at 14px; only safety information a person has to take in before acting
 * - the guidance chat's disclaimer - is set at the 16px body size.
 */
describe('Notice body text size', () => {
  it('stays at the smaller size by default', () => {
    render(<Notice>Entries show which fields changed.</Notice>)

    const body = screen.getByText('Entries show which fields changed.')
    expect(body).toHaveClass('text-sm')
    expect(body).not.toHaveClass('text-base')
  })

  it('is set at body size when asked for', () => {
    render(
      <Notice tone="info" size="base">
        Contact your doctor or emergency services directly.
      </Notice>,
    )

    const body = screen.getByText('Contact your doctor or emergency services directly.')
    expect(body).toHaveClass('text-base')
    expect(body).not.toHaveClass('text-sm')
  })
})
