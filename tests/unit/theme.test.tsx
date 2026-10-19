import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeControl } from '@/components/layout/theme-control'
import {
  readThemePreference,
  resetThemeForTests,
  resolveTheme,
  startTheme,
  THEME_STORAGE_KEY,
} from '@/lib/theme'

/**
 * Light, Dark and System (the 2nd-half plan, section 8): what is applied, what
 * is remembered, and that every control on the page shows the same choice.
 * The colours themselves are checked on the rendered screens in both themes
 * (`e2e/contrast-audit.spec.ts`).
 */

let systemDark = false
const changeListeners = new Set<() => void>()

function mockMatchMedia() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('dark') && systemDark
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => changeListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => changeListeners.delete(listener),
    })),
  )
}

function setSystemDark(value: boolean) {
  systemDark = value
  act(() => {
    for (const listener of changeListeners) listener()
  })
}

const theme = () => document.documentElement.dataset['theme']

beforeEach(() => {
  systemDark = false
  changeListeners.clear()
  mockMatchMedia()
  localStorage.clear()
  resetThemeForTests()
  delete document.documentElement.dataset['theme']
  document.head.innerHTML = '<meta name="theme-color" content="#004269" />'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the stored choice', () => {
  it('is Light until someone chooses', () => {
    expect(readThemePreference()).toBe('light')
  })

  it('ignores a value it does not know', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readThemePreference()).toBe('light')
  })

  it('falls back to Light when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readThemePreference()).toBe('light')
    vi.restoreAllMocks()
  })

  it('resolves System to the device’s own setting', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('applying it', () => {
  it('sets the theme, the form controls’ colour scheme and the address bar before anything renders', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    startTheme()
    expect(theme()).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#0c1420')
  })
})

describe('the theme control', () => {
  it('offers Light, Dark and System as one radio group, with the stored choice checked', () => {
    startTheme()
    render(<ThemeControl />)
    const group = screen.getByRole('group', { name: 'Theme' })
    expect(within(group).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'light',
      'dark',
      'system',
    ])
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeChecked()
  })

  it('applies and remembers a choice, and every control on the page shows it', () => {
    startTheme()
    render(
      <>
        <ThemeControl />
        <ThemeControl />
      </>,
    )
    fireEvent.click(screen.getAllByRole('radio', { name: 'Dark' })[0]!)

    expect(theme()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    for (const radio of screen.getAllByRole('radio', { name: 'Dark' })) expect(radio).toBeChecked()
  })

  it('on System, follows the device while the page is open, and stops once another choice is made', () => {
    startTheme()
    render(<ThemeControl />)
    fireEvent.click(screen.getByRole('radio', { name: 'System' }))
    expect(theme()).toBe('light')

    setSystemDark(true)
    expect(theme()).toBe('dark')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    setSystemDark(false)
    setSystemDark(true)
    expect(theme()).toBe('light')
  })

  it('takes a choice made in another tab', () => {
    startTheme()
    render(<ThemeControl />)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }))
    })
    expect(theme()).toBe('dark')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })
})
