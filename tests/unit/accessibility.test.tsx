import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { Tabs } from '@/components/ui/tabs'
import { appointmentStatus, medicationLogStatus } from '@/lib/status'

/**
 * Accessibility guarantees that are easy to break by accident and invisible
 * when they are broken — nothing looks wrong on screen if a label stops being
 * associated with its input.
 */
describe('Field', () => {
  it('associates the visible label with the control', async () => {
    render(
      <Field label="Contact number">
        <Input />
      </Field>,
    )

    // getByLabelText only finds it if the htmlFor/id wiring is intact.
    const input = screen.getByLabelText('Contact number')
    await userEvent.type(input, '0917')
    expect(input).toHaveValue('0917')
  })

  it('marks a required field for assistive technology, not just with an asterisk', () => {
    render(
      <Field label="Email address" required>
        <Input />
      </Field>,
    )

    // A bare "*" is meaningless when read aloud.
    expect(screen.getByText('(required)')).toBeInTheDocument()
  })

  it('connects the error to the input and announces it', () => {
    render(
      <Field label="Email address" error="Enter a valid email address">
        <Input />
      </Field>,
    )

    const input = screen.getByLabelText('Email address')
    expect(input).toHaveAttribute('aria-invalid', 'true')

    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent('Enter a valid email address')
    expect(input.getAttribute('aria-describedby')).toContain(error.id)
  })

  it('connects helper text to the input', () => {
    render(
      <Field label="Password" description="At least 12 characters">
        <Input />
      </Field>,
    )

    const input = screen.getByLabelText('Password')
    const description = screen.getByText('At least 12 characters')
    expect(input.getAttribute('aria-describedby')).toContain(description.id)
  })

  it('refuses to render a control outside a Field', () => {
    // Silently rendering an unlabelled input is the failure mode worth
    // preventing; a loud error during development is preferable.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    expect(() => render(<Input />)).toThrow(/must be rendered inside a <Field>/)

    consoleError.mockRestore()
  })
})

describe('StatusBadge', () => {
  it('shows an icon and a text label, never colour alone', () => {
    render(<StatusBadge status={appointmentStatus.confirmed} />)
    expect(screen.getByText('Confirmed')).toBeInTheDocument()
  })

  it('keeps the label available to screen readers in icon-only mode', () => {
    // Dense tables hide the text visually. It must still be announced,
    // otherwise the status becomes an unlabelled coloured dot.
    render(<StatusBadge status={medicationLogStatus.missed} iconOnly />)
    expect(screen.getByText('Missed')).toBeInTheDocument()
  })

  it('distinguishes statuses by more than tone', () => {
    const { container: taken } = render(
      <StatusBadge status={medicationLogStatus.taken} />,
    )
    const { container: missed } = render(
      <StatusBadge status={medicationLogStatus.missed} />,
    )

    expect(taken.textContent).not.toBe(missed.textContent)
  })
})

describe('Button', () => {
  it('announces its loading state rather than only showing a spinner', () => {
    render(<Button isLoading loadingLabel="Signing you in…">Sign in</Button>)

    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
    expect(screen.getByText('Signing you in…')).toBeInTheDocument()
  })

  it('keeps its visible label while loading so it does not resize', () => {
    render(<Button isLoading>Save changes</Button>)
    expect(screen.getByText('Save changes')).toBeInTheDocument()
  })

  it('defaults to type="button" so it cannot submit a form by accident', () => {
    render(<Button>Cancel</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('does not fire while loading', async () => {
    const onClick = vi.fn()
    render(<Button isLoading onClick={onClick}>Save</Button>)

    await userEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Tabs', () => {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'recovery', label: 'Recovery' },
    { id: 'notes', label: 'Notes' },
  ] as const

  it('exposes exactly one tab as the tab stop', () => {
    render(
      <Tabs tabs={tabs} value="recovery" onChange={() => {}}>
        <p>panel</p>
      </Tabs>,
    )

    const selected = screen.getByRole('tab', { selected: true })
    expect(selected).toHaveTextContent('Recovery')
    expect(selected).toHaveAttribute('tabindex', '0')

    // The rest must not be tab stops, or a keyboard user has to walk through
    // every tab to reach the panel.
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'tabindex',
      '-1',
    )
  })

  it('moves between tabs with the arrow keys', async () => {
    const onChange = vi.fn()
    render(
      <Tabs tabs={tabs} value="overview" onChange={onChange}>
        <p>panel</p>
      </Tabs>,
    )

    screen.getByRole('tab', { name: 'Overview' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledWith('recovery')
  })

  it('wraps from the last tab back to the first', async () => {
    const onChange = vi.fn()
    render(
      <Tabs tabs={tabs} value="notes" onChange={onChange}>
        <p>panel</p>
      </Tabs>,
    )

    screen.getByRole('tab', { name: 'Notes' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledWith('overview')
  })

  it('jumps to the first and last tab with Home and End', async () => {
    const onChange = vi.fn()
    render(
      <Tabs tabs={tabs} value="recovery" onChange={onChange}>
        <p>panel</p>
      </Tabs>,
    )

    screen.getByRole('tab', { name: 'Recovery' }).focus()
    await userEvent.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith('notes')

    await userEvent.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('overview')
  })

  it('links the panel to its tab', () => {
    render(
      <Tabs tabs={tabs} value="overview" onChange={() => {}}>
        <p>panel content</p>
      </Tabs>,
    )

    const panel = screen.getByRole('tabpanel')
    const tab = screen.getByRole('tab', { selected: true })
    expect(panel).toHaveAttribute('aria-labelledby', tab.id)
    expect(tab).toHaveAttribute('aria-controls', panel.id)
  })
})
