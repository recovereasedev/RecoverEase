import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ErrorState } from '@/components/feedback/state-view'

/**
 * Phase 2B: the shared components set no text below 14px. Their 12px
 * classes (`text-xs`, `text-label-sm`, a bare `text-[12px]`) were the
 * smallest text on most screens: a badge, a table's column names, a tab's
 * count. Pages still carry their own 12px labels; those move with their
 * page's redesign, not here.
 */
const SHARED = [
  'src/components/ui/badge.tsx',
  'src/components/ui/button.tsx',
  'src/components/ui/card.tsx',
  'src/components/ui/data-table.tsx',
  'src/components/ui/list-row.tsx',
  'src/components/ui/progress.tsx',
  'src/components/ui/section-heading.tsx',
  'src/components/ui/tabs.tsx',
  'src/components/layout/page-header.tsx',
  'src/components/layout/theme-control.tsx',
  'src/components/feedback/state-view.tsx',
]

describe('the shared components', () => {
  it.each(SHARED)('%s sets no text below 14px', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8')
    expect(source.match(/\btext-(xs|label-sm|\[(?:[0-9]|1[0-3])px\])(?![\w-])/g) ?? []).toEqual([])
  })
})

describe('a failure to load', () => {
  it('is shown without the emergency colour', () => {
    // A request that failed is a technical fault, not a clinical alarm. The
    // alert role still announces it.
    const { container, getByRole } = render(<ErrorState error={new Error('boom')} />)
    expect(getByRole('alert')).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/danger/)
  })
})
