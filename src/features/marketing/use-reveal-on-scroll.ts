import { useEffect, type RefObject } from 'react'

/**
 * The landing page's one motion: each `[data-reveal]` element inside `root`
 * fades and rises into place the first time it comes into view (index.css,
 * "Landing reveal").
 *
 * The hiding is opt-in and done last. Until this marks `root` as ready,
 * nothing is hidden - so with no script, no IntersectionObserver, or reduced
 * motion asked for, every section is simply there. Anything already on
 * screen is marked revealed before the switch, so it never blinks out; only
 * what is still below the fold waits for its moment. Each element is shown
 * once and then left alone.
 */
export function useRevealOnScroll(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.setAttribute('data-revealed', '')
          observer.unobserve(entry.target)
        }
      },
      // A little way into the viewport, so the motion is seen rather than
      // finished before the element is.
      { rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
    )

    for (const target of element.querySelectorAll<HTMLElement>('[data-reveal]')) {
      if (target.getBoundingClientRect().top < window.innerHeight) {
        target.setAttribute('data-revealed', '')
      } else {
        observer.observe(target)
      }
    }
    element.setAttribute('data-reveal-ready', '')

    return () => {
      observer.disconnect()
      element.removeAttribute('data-reveal-ready')
    }
  }, [root])
}
