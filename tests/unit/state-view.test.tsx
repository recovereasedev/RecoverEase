import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { StateView, describeError } from '@/components/feedback/state-view'

/**
 * StateView is the component every data-backed screen delegates its
 * loading/error/empty handling to, so a bug here is a bug on every page.
 *
 * The case worth guarding hardest is the first one: a slow request must never
 * render as "nothing here". That is the failure that makes a patient believe
 * they have no medication scheduled.
 */
describe('StateView', () => {
  const empty = <p>You have no appointments</p>

  it('shows the loading state while a request is in flight', () => {
    render(
      <StateView isPending data={undefined} empty={empty}>
        {() => <p>content</p>}
      </StateView>,
    )

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('You have no appointments')).not.toBeInTheDocument()
  })

  it('never shows the empty state while still pending, even with empty data', () => {
    // The regression this pins: `data` has arrived as [] from a previous
    // render, and a refetch is in flight. Checking emptiness before pending
    // would tell the user there is nothing there.
    render(
      <StateView isPending data={[]} empty={empty}>
        {() => <p>content</p>}
      </StateView>,
    )

    expect(screen.queryByText('You have no appointments')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('prefers the error state over the empty state', () => {
    render(
      <StateView isPending={false} error={new Error('boom')} data={[]} empty={empty}>
        {() => <p>content</p>}
      </StateView>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('You have no appointments')).not.toBeInTheDocument()
  })

  it('shows the empty state only once loading has finished with no rows', () => {
    render(
      <StateView isPending={false} data={[]} empty={empty}>
        {() => <p>content</p>}
      </StateView>,
    )

    expect(screen.getByText('You have no appointments')).toBeInTheDocument()
  })

  it('renders content when there is data', () => {
    render(
      <StateView isPending={false} data={['a', 'b']} empty={empty}>
        {(items) => <p>{items.length} items</p>}
      </StateView>,
    )

    expect(screen.getByText('2 items')).toBeInTheDocument()
  })

  it('treats undefined data after loading as an error, not as empty', () => {
    // A query that resolved to nothing at all is a fault, not an empty list.
    // Rendering the empty state would hide a broken request.
    render(
      <StateView isPending={false} data={undefined} empty={empty}>
        {() => <p>content</p>}
      </StateView>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('You have no appointments')).not.toBeInTheDocument()
  })

  it('honours a custom emptiness test', () => {
    render(
      <StateView
        isPending={false}
        data={{ rows: [] }}
        isEmpty={(data) => data.rows.length === 0}
        empty={empty}
      >
        {() => <p>content</p>}
      </StateView>,
    )

    expect(screen.getByText('You have no appointments')).toBeInTheDocument()
  })

  it('offers a retry that calls back', async () => {
    const onRetry = vi.fn()
    render(
      <StateView
        isPending={false}
        error={new Error('boom')}
        data={undefined}
        onRetry={onRetry}
      >
        {() => <p>content</p>}
      </StateView>,
    )

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('describeError', () => {
  it('translates a network failure into plain language', () => {
    const result = describeError(new Error('Failed to fetch'))
    expect(result.title).toBe('No connection')
    expect(result.description).toMatch(/internet connection/i)
  })

  it('translates a policy denial without exposing the policy', () => {
    // "new row violates row-level security policy" tells a patient nothing,
    // and hints at the schema. The user-facing text says neither.
    const result = describeError(
      new Error('new row violates row-level security policy for table "patient"'),
    )
    expect(result.title).toMatch(/do not have access/i)
    expect(result.description).not.toMatch(/row-level security/i)
    expect(result.description).not.toMatch(/patient"/)
  })

  it('falls back to a generic message for anything unrecognised', () => {
    const result = describeError(new Error('ECONNRESET 0x80070005'))
    expect(result.title).toBe('Something went wrong')
    expect(result.description).not.toMatch(/ECONNRESET/)
  })

  it('handles a thrown value that is not an Error', () => {
    expect(() => describeError({ weird: true })).not.toThrow()
    expect(describeError('a string').title).toBe('Something went wrong')
  })
})
