import { expect, IDS, test, type Page, type SupabaseStub } from './support/fixtures'

/**
 * F-02 — cancelling an appointment, end to end in the browser.
 *
 * The notices themselves are written by a database trigger, which the stub
 * cannot run; its wording and recipients are covered by the database suite.
 * Here the trigger's output is modelled on the cancelling request, so what is
 * under test is the interface: the confirmation, the request it sends, and
 * that the new notice reaches the bell and the list straight away rather
 * than after the minute-long poll.
 */

/** Adds the notice the database writes when this request cancels something. */
async function modelCancellationTrigger(
  page: Page,
  stub: SupabaseStub,
  notice: { userId: string; message: string },
): Promise<unknown[]> {
  const patches: unknown[] = []
  await page.route('**/rest/v1/appointment**', async (route) => {
    const request = route.request()
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>
      patches.push(body)
      if (body['appointment_status'] === 'cancelled') {
        stub.addRows('notification', [
          {
            notification_id: `n-cancel-${patches.length}`,
            user_id: notice.userId,
            chat_session_id: null,
            notification_type: 'appointment',
            notification_message: notice.message,
            notification_is_read: false,
            notification_created_at: new Date().toISOString(),
          },
        ])
      }
    }
    // On to the stub, which applies the update as the database would.
    await route.fallback()
  })
  return patches
}

test.describe('cancelling an appointment (F-02)', () => {
  test('a patient confirms first, then the notice appears at once', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient')
    const message = 'Your appointment on Monday, 14 September at 10:00 has been cancelled.'
    const patches = await modelCancellationTrigger(page, stub, {
      userId: IDS.aliceUser,
      message,
    })

    await page.goto('/patient/appointments')
    await expect(page.getByText('Scheduled').first()).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Notifications, none unread' }),
    ).toBeVisible()

    // Asked first, and told what it does.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Cancel this appointment?')
    await expect(dialog).toContainText('This appointment will be cancelled.')
    await expect(dialog).toContainText(
      'Your doctor is notified, and no reminder is sent for it.',
    )

    // Keeping it sends nothing.
    await dialog.getByRole('button', { name: /keep appointment/i }).click()
    await expect(dialog).not.toBeVisible()
    expect(patches).toHaveLength(0)
    await expect(page.getByText('Scheduled').first()).toBeVisible()

    // Cancelling sends the existing status update, and only that.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /cancel appointment/i })
      .click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
    expect(patches).toEqual([{ appointment_status: 'cancelled' }])
    // The client never writes the notice itself; the database does.
    expect(stub.requests).not.toContain('POST notification')

    // Well inside the one-minute poll: this is the refresh, not the timer.
    const bell = page.getByRole('link', { name: 'Notifications, 1 unread' })
    await expect(bell).toBeVisible()
    await bell.click()
    // Scoped to the list item: its "Mark read" button repeats the message for
    // screen readers, so an unscoped match finds it twice.
    const notice = page.getByRole('listitem').filter({ hasText: message })
    await expect(notice).toBeVisible()
    await expect(notice.getByRole('button', { name: /mark read/i })).toBeVisible()
  })

  test('a doctor cancels from the confirmation and sees the notice', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('doctor')
    const message =
      'The appointment with Alice Santos on Monday, 14 September at 10:00 has been cancelled.'
    const patches = await modelCancellationTrigger(page, stub, {
      userId: IDS.doctorAUser,
      message,
    })

    await page.goto('/doctor/appointments')
    await expect(
      page.getByRole('link', { name: 'Notifications, none unread' }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Cancel this appointment?')
    await expect(dialog).toContainText('Alice Santos')
    await expect(dialog).toContainText(
      'The patient is notified, and no reminder is sent.',
    )
    expect(patches).toHaveLength(0)

    await dialog.getByRole('button', { name: /cancel appointment/i }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
    // Settled: no Cancel left to offer on it.
    await expect(
      page.getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0)
    expect(patches).toEqual([{ appointment_status: 'cancelled' }])
    expect(stub.requests).not.toContain('POST notification')

    const bell = page.getByRole('link', { name: 'Notifications, 1 unread' })
    await expect(bell).toBeVisible()
    await bell.click()
    // Scoped to the list item: its "Mark read" button repeats the message for
    // screen readers, so an unscoped match finds it twice.
    const notice = page.getByRole('listitem').filter({ hasText: message })
    await expect(notice).toBeVisible()
    await expect(notice.getByRole('button', { name: /mark read/i })).toBeVisible()
  })

  test('confirming attendance is unchanged and notifies nobody', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient')
    const patches = await modelCancellationTrigger(page, stub, {
      userId: IDS.aliceUser,
      message: 'unused',
    })

    await page.goto('/patient/appointments')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()

    await expect(page.getByText('Confirmed').first()).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(patches).toEqual([{ appointment_status: 'confirmed' }])
    await expect(
      page.getByRole('link', { name: 'Notifications, none unread' }),
    ).toBeVisible()
  })
})
