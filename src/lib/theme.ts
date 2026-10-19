import { useSyncExternalStore } from 'react'

/**
 * Light, Dark or System - the 2nd-half plan, section 8.
 *
 * The choice is remembered on this device (`localStorage`), as RecoverEase
 * keeps its other per-device conveniences in web storage; it is not part of
 * anyone's record. `startTheme()` applies it before the first render
 * (main.tsx), so the page never flashes the other theme first, by setting
 * `data-theme` on the root element to the theme that results: `system`
 * follows the device's own setting, and keeps following it while the page is
 * open. One store, so every control on the page shows the same choice, and a
 * choice made in another tab arrives here too.
 *
 * Until someone chooses, the theme is Light: what everyone saw before, and
 * the theme every screen was audited in first.
 *
 * The colours themselves are tokens (index.css). Printing always uses the
 * light ones.
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'recoverease.theme'
export const DEFAULT_THEME: ThemePreference = 'light'

/** The browser's address-bar colour for each theme: the shell's own surface. */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#004269', dark: '#0c1420' }

const SYSTEM_DARK = '(prefers-color-scheme: dark)'

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isPreference(stored) ? stored : DEFAULT_THEME
  } catch {
    // Storage blocked: the default, every time.
    return DEFAULT_THEME
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_DARK).matches
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

/** Puts a preference into effect on the page, and says which theme it gave. */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const theme = resolveTheme(preference, systemPrefersDark())
  const root = document.documentElement
  root.dataset['theme'] = theme
  root.style.colorScheme = theme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[theme])
  return theme
}

// --- One store for the page ----------------------------------------------------

let current: ThemePreference | null = null
const listeners = new Set<() => void>()

function preferenceNow(): ThemePreference {
  if (current === null) current = readThemePreference()
  return current
}

function update(next: ThemePreference) {
  current = next
  applyTheme(next)
  for (const listener of listeners) listener()
}

export function setThemePreference(next: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // Applied for this page only.
  }
  update(next)
}

/** Undoes what `startTheme` set up; null until it has run. */
let stop: (() => void) | null = null

/**
 * Applies the stored choice, and keeps it applied: following the device
 * while the choice is `system`, and another tab's choice when it changes.
 * Called once, before the first render.
 */
export function startTheme(): void {
  applyTheme(preferenceNow())
  if (stop) return
  const followDevice = () => {
    if (preferenceNow() === 'system') update('system')
  }
  const followOtherTabs = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) update(readThemePreference())
  }
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(SYSTEM_DARK) : null
  query?.addEventListener('change', followDevice)
  window.addEventListener('storage', followOtherTabs)
  stop = () => {
    query?.removeEventListener('change', followDevice)
    window.removeEventListener('storage', followOtherTabs)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current choice, and a way to change it. */
export function useThemePreference(): {
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
} {
  const preference = useSyncExternalStore(subscribe, preferenceNow, () => DEFAULT_THEME)
  return { preference, setPreference: setThemePreference }
}

/** For tests: forget the page's choice and its listeners, as a fresh load would. */
export function resetThemeForTests(): void {
  stop?.()
  stop = null
  current = null
}
