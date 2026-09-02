import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Sizes are set in pixels that clear a 44px touch target at `md` and above,
 * which is the minimum comfortable tap area on a phone. `sm` is 40px and is
 * meant for controls inside a table row, where the row itself provides
 * additional hit area.
 *
 * The focus ring is inherited from the global `:focus-visible` rule rather
 * than redefined per variant, so it cannot be accidentally removed here.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'rounded-[var(--radius-md)] font-medium',
    'transition-colors duration-[var(--duration-fast)]',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        primary:
          'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800',
        accent:
          'bg-accent-700 text-white hover:bg-accent-800 active:bg-accent-900',
        secondary:
          'bg-surface text-heading border border-[var(--color-border-strong)] hover:bg-neutral-50 active:bg-neutral-100',
        ghost: 'text-body hover:bg-neutral-100 active:bg-neutral-200',
        danger:
          'bg-danger-700 text-white hover:bg-danger-800 active:bg-danger-800',
        link: 'text-brand-700 underline underline-offset-4 hover:text-brand-800',
      },
      size: {
        sm: 'h-10 px-3 text-sm [&_svg]:size-4',
        md: 'h-11 px-4 text-sm [&_svg]:size-4',
        lg: 'h-12 px-6 text-base [&_svg]:size-5',
        icon: 'size-11 [&_svg]:size-5',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      block: false,
    },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner and blocks interaction. */
    isLoading?: boolean
    /**
     * Announced to screen readers while loading. Without it, a spinner is a
     * purely visual signal and non-sighted users get no feedback that
     * anything happened.
     */
    loadingLabel?: string
    children?: ReactNode
  }

export function Button({
  className,
  variant,
  size,
  block,
  isLoading = false,
  loadingLabel = 'Working…',
  disabled,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading ? (
        <>
          <Loader2 className="animate-spin" aria-hidden="true" />
          <span className="sr-only">{loadingLabel}</span>
        </>
      ) : null}
      {/* The visible label stays put while loading so the button does not
          change width mid-click. An icon button has no label to keep. */}
      {isLoading && size === 'icon' ? null : children}
    </button>
  )
}

export { buttonVariants }
