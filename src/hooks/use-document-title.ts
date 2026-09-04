import { useEffect } from 'react'

/** The tab title for the application as a whole, and for its home page. */
const BASE_TITLE = 'RecoverEase'

/**
 * Names the browser tab for the page that mounts this.
 *
 * The base title is restored on unmount, so a page that does not name itself
 * shows `RecoverEase` rather than inheriting whatever the previous page set.
 * That keeps the default identical to the `<title>` in `index.html`, which is
 * what every page showed before descriptive titles existed.
 *
 * Titles are passed explicitly rather than derived from the page heading: the
 * sign-in heading already contains the product name, and the auth screens
 * swap their heading mid-flow ("Check your email", "This link has expired"),
 * which would rename the tab in the middle of a task.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${BASE_TITLE} | ${title}`

    return () => {
      document.title = BASE_TITLE
    }
  }, [title])
}
