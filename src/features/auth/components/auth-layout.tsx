import { HeartPulse, Lock, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { BrandWordmark } from '@/components/layout/brand'

/**
 * Shared frame for sign-in, password reset and consent screens.
 *
 * The brand panel is the second and last sanctioned use of the blue-to-teal
 * gradient. It is hidden below `lg`, where the screen belongs to the form: on
 * a phone, decoration above the fold just pushes the password field out of
 * reach.
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
    <div className="min-h-dvh lg:grid lg:grid-cols-[1fr_1.1fr]">
      {/* --- Brand panel (desktop only) --------------------------------- */}
      <aside className="brand-gradient relative hidden flex-col justify-between p-12 text-white lg:flex">
        <Link to="/" className="inline-flex w-fit items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-[var(--radius-md)] bg-white/15">
            <HeartPulse className="size-5" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold tracking-tight">
            RecoverEase
          </span>
        </Link>

        <div className="max-w-md">
          <p className="text-2xl font-semibold leading-snug">
            Recovery is easier to follow when everything is in one place.
          </p>
          <p className="mt-4 text-white/80">
            Treatment plans, medication schedules, appointments and daily
            progress — shared between you and your care team.
          </p>
        </div>

        <ul className="space-y-3 text-sm text-white/80">
          <li className="flex items-center gap-3">
            <ShieldCheck className="size-5 shrink-0" aria-hidden="true" />
            Your records are visible only to you and your assigned clinician.
          </li>
          <li className="flex items-center gap-3">
            <Lock className="size-5 shrink-0" aria-hidden="true" />
            Access is enforced by the database, not just the interface.
          </li>
        </ul>
      </aside>

      {/* --- Form column -------------------------------------------------- */}
      <main className="flex min-h-dvh flex-col justify-center px-5 py-10 sm:px-8">
        <div className="mx-auto w-full max-w-md">
          <Link to="/" className="mb-8 inline-block lg:hidden">
            <BrandWordmark />
          </Link>

          <h1 className="text-2xl font-semibold tracking-tight text-heading">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 text-muted">{description}</p>
          ) : null}

          <div className="mt-8">{children}</div>

          {footer ? <div className="mt-8">{footer}</div> : null}
        </div>
      </main>
    </div>
  )
}
