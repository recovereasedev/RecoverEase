import { useId } from 'react'

import { cn } from '@/lib/utils'

/**
 * The RecoverEase mark: a medical cross carrying a pulse line.
 *
 * This is one of only two places the blue-to-teal gradient from the design
 * system appears (the other is the auth/landing brand panel). Keeping it
 * scarce is what lets it function as identity rather than decoration.
 */
export function BrandMark({ className }: { className?: string | undefined }) {
  // The gradient id must be unique per instance. The shell renders the mark
  // up to three times at once (sidebar, header, drawer), and a shared id makes
  // every `url(#…)` resolve to the first match in the document - which on a
  // phone is the one inside the `display:none` desktop sidebar, so the mark
  // paints as nothing at all. `useId` is stable across server and client
  // render, so this does not reintroduce a hydration mismatch.
  const gradientId = useId()

  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-8 shrink-0', className)}
      role="img"
      aria-label="RecoverEase"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-brand-800)" />
          <stop offset="100%" stopColor="var(--color-accent-600)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      <path
        d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z"
        fill="#fff"
        opacity="0.22"
      />
      <path
        d="M5 16h4.6l2.2-4.4 3.4 8.2 2.6-5.4 1.7 1.6H27"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function BrandWordmark({
  className,
  markClassName,
}: {
  className?: string | undefined
  markClassName?: string | undefined
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark className={markClassName} />
      <span className="text-lg font-semibold tracking-tight text-heading">
        RecoverEase
      </span>
    </span>
  )
}

/**
 * The wordmark with a second line naming the portal you are in.
 *
 * Used at the top of the sidebar and drawer, where the design system pairs
 * the brand with its context. The subtitle is a real fact about the signed-in
 * session, not decoration: it is the first answer to "where am I".
 */
export function BrandLockup({
  subtitle,
  className,
}: {
  subtitle: string
  className?: string | undefined
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-3', className)}>
      <BrandMark className="size-10" />
      <span className="min-w-0">
        <span className="block truncate text-lg font-semibold tracking-tight text-heading">
          RecoverEase
        </span>
        <span className="block truncate text-label-sm font-semibold text-accent-700">
          {subtitle}
        </span>
      </span>
    </span>
  )
}
