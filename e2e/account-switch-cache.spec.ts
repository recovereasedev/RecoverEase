import type { Page, Route } from '@playwright/test'

import { datasetFor, expect, IDS, SupabaseStub, test } from './support/fixtures'

/**
 * One tab, two clinicians: a shared clinic computer where Dr Cruz signs out
 * and Dr Lim signs in on the same page, without a reload. The tab keeps one
 * query cache throughout, and `patients.list()` is answered by RLS with the
 * asking doctor's own patients - so the second doctor must see theirs, never
 * a list cached for the first.
 *
 * The stub does not model RLS (see supabase-stub.ts), so this spec answers
 * the patient list itself, per the account named in the request's token, as
 * the database would. That is the only thing it overrides.
 */

const PASSWORD = 'correct-horse-battery'

const DOCTOR_OF: Record<string, string> = {
  [IDS.doctorAUser]: IDS.doctorA,
  [IDS.doctorBUser]: IDS.doctorB,
}

/** The account a request was made as: the `sub` of its bearer token. */
function askedBy(route: Route): string | null {
  const token = (route.request().headers()['authorization'] ?? '').replace(
    /^Bearer /,
    '',
  )
  const payload = token.split('.')[1]
  if (!payload) return null
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as { sub?: string }
  return claims.sub ?? null
}

function twoDoctors() {
  const data = datasetFor('doctor')
  const [alice] = data['patient']!
  const [doctorA] = data['doctor']!

  data['user_account'] = [
    ...data['user_account']!,
    {
      user_id: IDS.doctorBUser,
      user_email: 'doctor.b@recoverease.test',
      user_role: 'doctor',
    },
  ]
  data['doctor'] = [
    doctorA!,
    {
      ...doctorA,
      doc_id: IDS.doctorB,
      user_id: IDS.doctorBUser,
      doc_first_name: 'Bea',
      doc_last_name: 'Lim',
      doc_license_no: 'LIC-B-002',
    },
  ]
  data['patient'] = [
    ...data['patient']!,
    {
      ...alice,
      pat_id: IDS.carolPat,
      user_id: IDS.carolUser,
      doc_id: IDS.doctorB,
      pat_first_name: 'Carol',
      pat_last_name: 'Tan',
    },
  ]
  return data
}

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/doctor$/)
}

async function openPatients(page: Page) {
  // Client-side navigation, not page.goto: a fresh load would start a new
  // cache and prove nothing.
  await page
    .getByRole('link', { name: 'Patients', exact: true })
    .first()
    .click()
  await expect(page).toHaveURL(/\/doctor\/patients$/)
}

test('the next doctor on the same tab sees their own patients, not the last doctor’s', async ({
  page,
}) => {
  const stub = new SupabaseStub(twoDoctors())
  await stub.install(page)

  // The patient list, as RLS answers it: the asking doctor's patients only.
  // Registered after the stub, so it is consulted first.
  const listAskedBy: Array<string | null> = []
  await page.route(/\/rest\/v1\/patient\?/, async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.searchParams.has('pat_id')) {
      await route.fallback()
      return
    }
    const asker = askedBy(route)
    listAskedBy.push(asker)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        stub
          .rowsIn('patient')
          .filter(
            (row) => asker !== null && row['doc_id'] === DOCTOR_OF[asker],
          ),
      ),
    })
  })

  // Dr Cruz signs in and opens their patients.
  await page.goto('/sign-in')
  await signIn(page, 'doctor.a@recoverease.test')
  await openPatients(page)

  // The list is laid out twice, as cards for a phone and a table for a
  // wider screen, so only the copy on show is looked for here. The absence
  // checks further down count both.
  const main = page.getByRole('main')
  const shown = (name: string) =>
    main.getByText(name).filter({ visible: true }).first()
  await expect(shown('Alice Santos')).toBeVisible()
  await expect(shown('Bob Reyes')).toBeVisible()

  // And signs out, leaving the tab as it is.
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expect(page).toHaveURL(/\/sign-in$/)

  // Dr Lim signs in on the same page, well inside the minute a cached list
  // would still count as fresh.
  await signIn(page, 'doctor.b@recoverease.test')
  await openPatients(page)

  await expect(shown('Carol Tan')).toBeVisible()
  await expect(main.getByText('Alice Santos')).toHaveCount(0)
  await expect(main.getByText('Bob Reyes')).toHaveCount(0)

  // The list on screen is the one asked for as Dr Lim, not a copy kept from
  // Dr Cruz's session.
  expect(listAskedBy).toContain(IDS.doctorBUser)
})
