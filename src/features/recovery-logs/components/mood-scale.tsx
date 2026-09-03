import { cn } from '@/lib/utils'

const MOOD_OPTIONS = [
  { value: 1, label: 'Very poor' },
  { value: 2, label: 'Poor' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Very good' },
] as const

/**
 * The 1-5 recovery rating from module 5.9.
 *
 * Built as a radio group rather than a row of buttons so arrow keys move
 * between options and only the selected one is a tab stop — the behaviour a
 * keyboard user already expects from a scale.
 *
 * Each option carries its word as well as its number. A bare 1-5 leaves the
 * patient guessing which end is good.
 */
export function MoodScale({
  value,
  onChange,
}: {
  value: number | null
  onChange: (value: number) => void
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-heading">
        How did you feel today?
      </legend>
      <p className="mt-1 text-sm text-muted">Optional.</p>

      {/* Five columns at every width. A scale that reflows into two rows
          stops reading as a scale - the order is the meaning - so the cells
          get narrower on a phone rather than wrapping. At 375px that is a
          55px column, comfortably past the 44px tap floor. */}
      <div className="mt-3 grid grid-cols-5 gap-1.5 sm:gap-2">
        {MOOD_OPTIONS.map((option) => {
          const isSelected = value === option.value

          return (
            <label
              key={option.value}
              className={cn(
                'flex min-h-[4.25rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border px-1 py-2.5 text-center transition-colors',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600',
                isSelected
                  ? 'border-brand-600 bg-brand-50'
                  : 'border-[var(--color-border-strong)] hover:bg-neutral-50',
              )}
            >
              <input
                type="radio"
                name="mood-rating"
                value={option.value}
                checked={isSelected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  'text-lg font-semibold',
                  isSelected ? 'text-brand-700' : 'text-neutral-500',
                )}
              >
                {option.value}
              </span>
              <span
                className={cn(
                  'text-xs leading-tight',
                  isSelected ? 'font-medium text-brand-700' : 'text-muted',
                )}
              >
                {option.label}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
