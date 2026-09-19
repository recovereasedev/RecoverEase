import { Lock, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { BrandMark } from '@/components/layout/brand'

/**
 * Shared frame for sign-in and the password-reset screens.
 *
 * Built mobile-first rather than as a shrunken desktop composition. The three
 * decisions that matter:
 *
 * 1. **The form is not in a card on a phone.** A card at 375px spends 32px of
 *    a 335px column on padding that separates the form from nothing — it is
 *    the only thing on screen. The card appears at `sm`, where a 448px column
 *    floating on an empty background does need anchoring.
 *
 * 2. **Centring is done with `my-auto`, not `justify-center`.** A centred flex
 *    item that grows taller than its container overflows in *both* directions,
 *    and the top half becomes unreachable — no scrollbar reaches above the
 *    start of the scroll box. That is exactly what happens on a 375x812 phone
 *    once the keyboard takes half the viewport. `my-auto` collapses to zero
 *    when there is no spare room, so the layout falls back to scrolling from
 *    the top instead of clipping.
 *
 * 3. **The brand panel is desktop-only.** On a phone, decoration above the
 *    fold pushes the password field under the keyboard. What is left is a
 *    compact mark-and-name lockup: enough presence to say whose product this
 *    is, not enough to compete with the form.
 *
 * RecoverEase 2.0: the panel is narrower than the form column and no longer
 * half a screen of gradient around one sentence. The statement is set large,
 * and a real RecoverEase screen - the patient's day, on a phone - rises from
 * its bottom edge, so the one expressive surface on the way in shows the
 * product rather than an empty colour field.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-canvas lg:grid lg:grid-cols-[5fr_7fr]">
      {/* --- Brand panel (desktop only) --------------------------------- */}
      <aside className="brand-gradient relative hidden flex-col overflow-hidden p-12 text-white lg:flex">
        <Link
          to="/"
          className="inline-flex w-fit items-center gap-3 rounded-[var(--radius-md)]"
        >
          <BrandMark className="size-10" />
          <span className="text-lg font-semibold tracking-tight">
            RecoverEase
          </span>
        </Link>

        <div className="mt-20 max-w-md">
          <p className="text-headline-xl text-white">
            Recovery is easier to follow when everything is in one place.
          </p>
          {/* Hierarchy here comes from size and weight, never from opacity.
              White at 80% over the teal end of the gradient drops under AA,
              and a translucent scale is the usual way that happens without
              anyone noticing. */}
          <p className="mt-4 text-body-lg text-white">
            Treatment plans, medication schedules, appointments and daily
            progress — shared between you and your care team.
          </p>
        </div>

        <ul className="relative z-10 mt-8 max-w-md space-y-3 text-sm text-white">
          <li className="flex items-center gap-3">
            <ShieldCheck className="size-5 shrink-0" aria-hidden="true" />
            Your records are visible only to you and your assigned clinician.
          </li>
          <li className="flex items-center gap-3">
            <Lock className="size-5 shrink-0" aria-hidden="true" />
            Access is enforced by the database, not just the interface.
          </li>
        </ul>

        {/* A real screen, partly below the panel's edge: the product, not a
            picture of healthcare. Decorative here - the page is a form, and
            the screen is a fictional patient's - so it is hidden from
            assistive technology. */}
        <img
          src="/landing/hero-patient.webp"
          alt=""
          aria-hidden="true"
          width={520}
          height={1040}
          decoding="async"
          className="pointer-events-none absolute -bottom-48 right-10 w-52 rounded-[1.5rem] border-4 border-white/25 shadow-[0_32px_64px_-16px_rgb(0_20_40/0.55)] xl:right-16 xl:w-60"
        />
      </aside>

      {/* --- Form column -------------------------------------------------- */}
      <main
        className={[
          'flex min-h-dvh flex-col px-5 pt-8',
          // Clears the iOS home indicator without leaving a gap on a device
          // that has none.
          'pb-[max(2rem,env(safe-area-inset-bottom))]',
          'sm:px-6 sm:pt-12 lg:px-10',
        ].join(' ')}
      >
        <div className="my-auto w-full">
          <div className="mx-auto w-full max-w-md">
            {/* Compact brand lockup. Replaced by the panel at `lg`. */}
            <div className="mb-7 flex flex-col items-center gap-3 lg:hidden">
              <Link to="/" className="rounded-[var(--radius-md)]">
                <BrandMark className="size-12" />
              </Link>
              <span className="text-lg font-semibold tracking-tight text-heading">
                RecoverEase
              </span>
            </div>

            <div className="text-center lg:text-left">
              <h1 className="text-headline-lg text-heading sm:text-title">
                {title}
              </h1>
              {description ? (
                <p className="mx-auto mt-2 max-w-sm text-body-md text-muted lg:mx-0">
                  {description}
                </p>
              ) : null}
            </div>

            {/* The form surface. Bare on a phone; a card from `sm` up. */}
            <div className="mt-6 sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--color-border)] sm:bg-surface sm:p-6 sm:shadow-[var(--shadow-sm)] lg:mt-8">
              {children}
            </div>

            {footer ? <div className="mt-6">{footer}</div> : null}
          </div>
        </div>
      </main>
    </div>
  )
}
