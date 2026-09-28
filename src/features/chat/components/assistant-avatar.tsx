import { BrandMark } from '@/components/layout/brand'
import { cn } from '@/lib/utils'

/**
 * Disc and mark sizes, phone then desktop. Whole pixels with an even margin
 * on every side, so the mark sits exactly centred and its edges stay crisp.
 */
const SIZES = {
  /** Beside each assistant message. */
  sm: { disc: 'size-7 lg:size-8', mark: 'size-[18px] lg:size-5' },
  /** In the assistant header. */
  md: { disc: 'size-10 lg:size-[46px]', mark: 'size-6 lg:size-7' },
  /** Above a new conversation. */
  lg: { disc: 'size-14 lg:size-16', mark: 'size-[34px] lg:size-10' },
} as const

/**
 * The Recovery Guidance Assistant's profile image: the RecoverEase mark,
 * centred on a pale disc. It is the product's own logo, not a persona - the
 * assistant is part of RecoverEase, not a separate AI, and a face or a robot
 * would promise more than general guidance.
 *
 * The disc is what keeps the mark distinct on the navy assistant header,
 * where the mark's own navy corner would otherwise run into the background.
 *
 * Decorative: the assistant's name is always written beside it, so the mark's
 * "RecoverEase" label is hidden rather than read out a second time.
 */
export function AssistantAvatar({ size = 'sm' }: { size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-accent-50',
        SIZES[size].disc,
      )}
    >
      <BrandMark className={SIZES[size].mark} />
    </span>
  )
}
