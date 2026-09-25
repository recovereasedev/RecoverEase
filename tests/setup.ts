import '@testing-library/jest-dom/vitest'

import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * How long `findBy*` and `waitFor` keep looking before they fail.
 *
 * Testing Library's default is one second. The first test in a file also
 * pays for loading its modules and the first render, which in an ordinary
 * full run already takes up to about a second, so under load a correct test
 * could fail with "Unable to find" while the page was still arriving. A
 * passing wait returns as soon as its condition holds, so this slows nothing
 * down; only a real failure takes longer to report. It stays under Vitest's
 * five-second test timeout, so such a failure still names what it was
 * waiting for.
 */
configure({ asyncUtilTimeout: 3000 })

/**
 * jsdom implements neither of these, and components that respect a user's
 * display preferences or scroll a message into view use both. Without them a
 * component test fails on the environment rather than on the component.
 *
 * `matchMedia` reports "no preference" for everything, which is the same
 * default a browser gives when the user has expressed none.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

afterEach(() => {
  cleanup()
})
