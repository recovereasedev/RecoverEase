import { cn } from '@/lib/utils'

/**
 * The Recovery Guidance Assistant's mark: a pale ring, a teal disc and the
 * recovery line from the RecoverEase logo. Deliberately not a face or a
 * robot - the assistant offers general guidance, and a persona would promise
 * more than that.
 *
 * Decorative: the assistant's name is always written beside it.
 */
export function AssistantAvatar({
  size = 32,
  ring = false,
  className,
}: {
  size?: number
  /** The pale outer ring, for the larger header and welcome marks. */
  ring?: boolean
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 46 46"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      {ring ? (
        <circle cx="23" cy="23" r="23" className="fill-accent-50" />
      ) : null}
      <circle cx="23" cy="23" r={ring ? 19 : 23} className="fill-accent-700" />
      <path
        d={ring ? 'M12 24h5.5l3-6 5 11 3-5H34' : 'M10 24.5h6l3.2-6.5 5.5 12.3 3.2-5.8H36'}
        fill="none"
        stroke="#fff"
        strokeWidth={ring ? 2.3 : 2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
