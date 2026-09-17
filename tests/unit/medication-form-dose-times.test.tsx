import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The medication form, after group QA 9/12/26 item 4. The clinician gives
 * doses a day, hours between them and the first dose; the form shows the
 * times it has worked out, and those are exactly the times it saves.
 */

const created = vi.hoisted(() => ({
  prescription: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  schedule: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}))

vi.mock('@/features/medications/hooks', () => ({
  useCreatePrescription: () => created.prescription,
  useCreateMedicationSchedule: () => created.schedule,
}))

const { MedicationForm } = await import('@/features/medications/components/medication-form')

beforeEach(() => {
  created.prescription.mutate.mockReset()
  created.schedule.mutate.mockReset()
})

function typeInto(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function shownTimes(): string[] {
  const list = screen.getByRole('list', { name: 'Dose times' })
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

function renderForm() {
  render(<MedicationForm patientId="pat-1" doctorId="doc-1" prescriptionId="presc-1" />)
  typeInto(/medicine/i, 'Amoxicillin')
  typeInto(/dosage/i, '500 mg')
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /add medicine/i }))

describe('setting a schedule by frequency and interval', () => {
  it('works out 08:00, 12:00 and 16:00 from 3 a day, every 4 hours, from 08:00', () => {
    renderForm()
    typeInto(/doses a day/i, '3')
    typeInto(/hours between doses/i, '4')
    typeInto(/first dose at/i, '08:00')

    expect(shownTimes()).toEqual(['08:00', '12:00', '16:00'])
  })

  it('asks for no time of any dose after the first', () => {
    renderForm()

    expect(screen.queryByRole('button', { name: /add another time/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/dose \d+ time/i)).not.toBeInTheDocument()
  })

  it('saves exactly the times it shows', () => {
    renderForm()
    typeInto(/doses a day/i, '3')
    typeInto(/hours between doses/i, '4')
    typeInto(/first dose at/i, '08:00')
    save()

    expect(created.schedule.mutate).toHaveBeenCalledTimes(1)
    expect(created.schedule.mutate.mock.calls[0]![0]).toMatchObject({
      prescriptionId: 'presc-1',
      name: 'Amoxicillin',
      dosage: '500 mg',
      times: ['08:00', '12:00', '16:00'],
    })
  })

  it('follows every change, so no earlier times are left behind', () => {
    renderForm()
    typeInto(/doses a day/i, '3')
    typeInto(/hours between doses/i, '4')
    typeInto(/first dose at/i, '08:00')

    typeInto(/hours between doses/i, '6')
    expect(shownTimes()).toEqual(['08:00', '14:00', '20:00'])

    typeInto(/doses a day/i, '2')
    expect(shownTimes()).toEqual(['08:00', '14:00'])

    typeInto(/first dose at/i, '07:30')
    expect(shownTimes()).toEqual(['07:30', '13:30'])

    save()
    expect(created.schedule.mutate.mock.calls[0]![0]).toMatchObject({
      times: ['07:30', '13:30'],
    })
  })

  it('says a refusal once, and drops it as soon as the times are corrected', () => {
    renderForm()
    typeInto(/doses a day/i, '3')
    typeInto(/hours between doses/i, '4')
    typeInto(/first dose at/i, '20:00')
    save()

    expect(screen.getAllByText(/would run past midnight/)).toHaveLength(1)
    expect(screen.getByText('Correct the highlighted field to see the times.')).toBeInTheDocument()

    typeInto(/first dose at/i, '08:00')

    expect(screen.queryByText(/would run past midnight/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/first dose at/i)).not.toHaveAttribute('aria-invalid')
    expect(shownTimes()).toEqual(['08:00', '12:00', '16:00'])
    expect(created.schedule.mutate).not.toHaveBeenCalled()
  })

  it('needs no interval for one dose a day', () => {
    renderForm()

    expect(screen.getByLabelText(/doses a day/i)).toHaveValue(1)
    expect(screen.getByLabelText(/hours between doses/i)).toBeDisabled()
    expect(shownTimes()).toEqual(['08:00'])

    save()
    expect(created.schedule.mutate.mock.calls[0]![0]).toMatchObject({ times: ['08:00'] })
  })

  it.each([
    ['doses a day of 0', { doses: '0' }, /doses a day/i, 'Doses a day must be a whole number from 1 to 12.'],
    ['13 doses a day', { doses: '13' }, /doses a day/i, 'Doses a day must be a whole number from 1 to 12.'],
    ['no interval', { doses: '3', hours: '' }, /hours between doses/i, 'Say how many hours apart the doses are.'],
    ['a part-hour interval', { doses: '3', hours: '1.5' }, /hours between doses/i, 'Hours between doses must be a whole number from 1 to 23.'],
    ['no first dose', { doses: '3', hours: '4', first: '' }, /first dose at/i, 'Choose the time of the first dose.'],
    [
      'doses past midnight',
      { doses: '5', hours: '4', first: '08:00' },
      /first dose at/i,
      '5 doses 4 hours apart from 08:00 would run past midnight. Choose an earlier first dose, fewer doses or fewer hours between them.',
    ],
  ])('refuses %s, says why next to the field, and saves nothing', (_label, values, field, message) => {
    renderForm()
    if (values.doses !== undefined) typeInto(/doses a day/i, values.doses)
    if ('hours' in values && values.hours !== undefined) typeInto(/hours between doses/i, values.hours)
    if ('first' in values && values.first !== undefined) typeInto(/first dose at/i, values.first)
    save()

    const input = screen.getByLabelText(field)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(expect.stringContaining(message))
    expect(screen.queryByRole('list', { name: 'Dose times' })).not.toBeInTheDocument()
    expect(created.schedule.mutate).not.toHaveBeenCalled()
    expect(created.prescription.mutate).not.toHaveBeenCalled()
  })
})
