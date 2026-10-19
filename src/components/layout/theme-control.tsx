import { Monitor, Moon, Sun } from 'lucide-react'
import { useId } from 'react'

import { useThemePreference, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * The theme choice (the 2nd-half plan, section 8): Light, Dark, or the
 * device's own setting. Native radio buttons, so arrow keys move between them
 * and a screen reader announces "Theme, radio group"; each option is a full
 * 44px target, with its word beside its icon so the choice never rests on an
 * icon alone. Remembered on this device (`src/lib/theme.ts`).
 */
export function ThemeControl({ className }: { className?: string }) {
  const { preference, setPreference } = useThemePreference()
  const name = useId()

  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="mb-1.5 px-1 text-xs font-semibold text-muted">Theme</legend>
      <div className="grid grid-cols-3 gap-1 rounded-[var(--radius-md)] bg-surface-sunken p-1">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <label
            key={value}
            className={cn(
              'flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-sm font-medium text-body',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--color-brand-600)]',
              preference === value && 'bg-surface font-semibold text-heading shadow-[var(--shadow-sm)]',
            )}
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={preference === value}
              onChange={() => setPreference(value)}
              className="sr-only"
            />
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
