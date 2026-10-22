import { useId } from 'react'

import { cn } from '@/lib/utils'

/**
 * A segmented control: one choice of a few, as native radio buttons.
 *
 * Radios rather than a row of toggle buttons for the reason the mood scale
 * gives: arrow keys move between the options and only the chosen one is a
 * tab stop, which is what a keyboard user expects from a set of choices.
 * The chosen option is marked by its raised surface, its weight and the
 * radio's own checked state - never by colour alone.
 */
export function ChoiceGroup<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  className,
}: {
  /** Names the group for assistive technology. */
  legend: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  const name = useId()

  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="sr-only">{legend}</legend>
      {/* Equal columns across a phone, so a longer label wraps inside its
          own option instead of pushing the last one onto a row of its own. */}
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-[var(--radius-md)] bg-surface-sunken p-1 sm:inline-grid sm:auto-cols-auto">
        {options.map((option) => {
          const isChecked = option.value === value
          return (
            <label
              key={String(option.value)}
              className={cn(
                'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-center text-sm leading-tight transition-colors duration-[var(--duration-fast)] sm:min-h-10 sm:px-4',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600',
                isChecked
                  ? 'bg-surface font-semibold text-heading shadow-[var(--shadow-xs)]'
                  : 'font-medium text-body hover:text-heading',
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(option.value)}
                checked={isChecked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
