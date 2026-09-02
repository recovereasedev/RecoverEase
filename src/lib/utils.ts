import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merges class names, resolving Tailwind conflicts so that a caller's
 * `className` reliably overrides a component's default rather than depending
 * on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Full name from the ERD's split first/last name columns. */
export function fullName(first: string, last: string): string {
  return `${first} ${last}`.trim()
}

/** Initials for an avatar, from the same split columns. */
export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
}

/**
 * Initials from an already-joined display name.
 *
 * Handles the honorific RecoverEase prefixes onto clinician names: "Dr Alan
 * Cruz" should read AC, not DA.
 */
export function initialsFromName(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => !/^(dr|mr|mrs|ms|prof)\.?$/i.test(word))

  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()

  return `${words[0]!.charAt(0)}${words[words.length - 1]!.charAt(0)}`.toUpperCase()
}
