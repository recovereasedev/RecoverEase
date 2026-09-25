import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AdherenceSummary } from '@/features/medications/components/adherence-summary'

/**
 * The weekly tally's wording (audit L6). Its `pending` count is every dose with
 * no record yet - still to come, due now or overdue - so it is called "Not yet
 * recorded", not "Due", which read wrong beside a dose list showing some of
 * those same doses as Overdue. The counts themselves are unchanged.
 */
describe('the adherence tally', () => {
  const adherence = { taken: 5, missed: 1, skipped: 1, pending: 3, resolved: 7, rate: 71 }

  it('calls doses with no record yet "Not yet recorded", with their count', () => {
    render(<AdherenceSummary adherence={adherence} />)

    const row = screen.getByText('Not yet recorded').closest('li') as HTMLElement
    expect(within(row).getByText('3')).toBeInTheDocument()
    expect(screen.queryByText('Due')).not.toBeInTheDocument()
  })

  it('keeps the other counts and their names', () => {
    render(<AdherenceSummary adherence={adherence} />)

    for (const [label, count] of [
      ['Taken', '5'],
      ['Missed', '1'],
      ['Skipped', '1'],
    ] as const) {
      const row = screen.getByText(label).closest('li') as HTMLElement
      expect(within(row).getByText(count)).toBeInTheDocument()
    }
    // The rate is still of the doses that have come due, not of the pending.
    expect(screen.getByText('7 doses')).toBeInTheDocument()
  })
})
