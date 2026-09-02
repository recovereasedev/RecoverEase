import { cn } from '@/lib/utils'

/**
 * The RecoverEase mark: a medical cross carrying a pulse line.
 *
 * This is one of only two places the blue-to-teal gradient from the design
 * document appears (the other is the auth/landing brand panel). Keeping it
 * scarce is what lets it function as identity rather than decoration.
 */
export function BrandMark({ className }: { className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-8 shrink-0', className)}
      role="img"
      aria-label="RecoverEase"
    >
      <defs>
        <linearGradient id="recoverease-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-brand-600)" />
          <stop offset="100%" stopColor="var(--color-accent-500)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="url(#recoverease-mark)" />
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
