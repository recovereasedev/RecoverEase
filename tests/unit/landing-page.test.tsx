import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LandingPage } from '@/features/marketing/pages/landing-page'

/**
 * The public landing page: its outline, its links, its pictures and what it
 * claims - and that its motion can never be the reason something is unseen.
 * Layout, the reveal in a real browser and the phone width are covered in
 * e2e/landing.spec.ts.
 */

function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the landing page', () => {
  it('has one h1, and the sections in the order the design sets out', () => {
    renderLanding()

    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    expect(h1[0]).toHaveTextContent('Recovery support, beyond the clinic.')

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      'Support for your recovery. Guidance from your care team.',
      'Everything your recovery asks of you, in one place',
      'Two people, one record',
      'How it works',
      'Made for patients and the clinicians treating them',
      'Helpful recovery guidance, with clear boundaries',
      'Access is enforced where the data lives',
      'Use it like an app, in your browser',
      'Frequently asked questions',
      'Getting started',
    ])
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Medical notice:')
  })

  it('points every in-page link at a section that exists', () => {
    const { container } = renderLanding()

    const anchors = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
    expect(anchors.length).toBeGreaterThan(10)
    for (const anchor of anchors) {
      const id = anchor.getAttribute('href')!.slice(1)
      expect(container.querySelector(`[id="${id}"]`), anchor.textContent ?? id).not.toBeNull()
    }
  })

  it('sends every sign-in to the application’s own route, and offers no sign-up', () => {
    renderLanding()

    const signIns = screen.getAllByRole('link', { name: /sign in/i })
    expect(signIns.length).toBeGreaterThanOrEqual(5)
    for (const link of signIns) expect(link).toHaveAttribute('href', '/sign-in')

    expect(screen.queryByRole('link', { name: /sign up|register/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
    expect(screen.getAllByText(/no public sign-up/i).length).toBeGreaterThan(0)
  })

  it('serves its pictures locally, sized, and described', () => {
    const { container } = renderLanding()

    const images = [...container.querySelectorAll('img')]
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) {
      expect(image.getAttribute('src')).toMatch(/^\/landing\/[a-z-]+\.webp$/)
      expect(Number(image.getAttribute('width'))).toBeGreaterThan(0)
      expect(Number(image.getAttribute('height'))).toBeGreaterThan(0)
      expect(image.getAttribute('alt')).toBeTruthy()
    }

    const portrait = screen.getByRole('img', { name: 'A clinician holding a tablet.' })
    expect(portrait).toHaveAttribute('src', '/landing/hero-clinician.webp')
    expect(portrait).toHaveAttribute('loading', 'eager')
    expect(portrait).toHaveAttribute('fetchpriority', 'high')
  })

  it('labels every example as an example, and every capture as sample data', () => {
    renderLanding()

    // The hero's day card and the dose schedule.
    expect(screen.getAllByText('Illustrative example.')).toHaveLength(2)
    expect(screen.getAllByText('Sample data.').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Example')).toBeInTheDocument()
    // Drawn examples are not forms: nothing on them can be typed into.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })

  it('makes none of the claims the code does not support', () => {
    const { container } = renderLanding()
    const text = container.textContent ?? ''

    for (const claim of [
      /cryptograph/i,
      /encrypt/i,
      /invitation/i,
      /calendar (sync|notification)/i,
      /offline notification/i,
      /24\/7/,
      /error-free/i,
      /in seconds/i,
      /upon (clinical )?discharge/i,
      /Dr\.? Sarah Lin/i,
      /recoverease\.app|vercel\.app/i,
      /91%/,
    ]) {
      expect(text, String(claim)).not.toMatch(claim)
    }
    // The emergency guidance names the Philippine hotline.
    expect(within(container).getAllByText(/911/).length).toBeGreaterThanOrEqual(1)
  })
})

describe('the landing page’s motion', () => {
  const observed: Element[] = []

  class FakeObserver {
    observe = (target: Element) => observed.push(target)
    unobserve = () => {}
    disconnect = () => {}
  }

  function preferReducedMotion(reduce: boolean) {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: reduce && query.includes('reduce'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
  }

  it('hides nothing without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { container } = renderLanding()

    expect(container.querySelector('[data-reveal-ready]')).toBeNull()
    expect(container.querySelectorAll('[data-reveal]').length).toBeGreaterThan(10)
  })

  it('hides nothing under reduced motion', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    preferReducedMotion(true)
    const { container } = renderLanding()

    expect(container.querySelector('[data-reveal-ready]')).toBeNull()
  })

  it('switches the reveal on otherwise, with on-screen sections shown at once', () => {
    observed.length = 0
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    preferReducedMotion(false)
    const { container } = renderLanding()

    expect(container.querySelector('[data-reveal-ready]')).not.toBeNull()
    // jsdom lays nothing out, so every element measures as on screen: each
    // is revealed straight away and none is left waiting on the observer.
    const reveals = [...container.querySelectorAll('[data-reveal]')]
    expect(reveals.every((element) => element.hasAttribute('data-revealed'))).toBe(true)
    expect(observed.filter((element) => element.hasAttribute('data-reveal'))).toHaveLength(0)
  })

  it('never animates the heading', () => {
    renderLanding()
    const h1 = screen.getByRole('heading', { level: 1 })

    expect(h1.closest('[data-reveal], .landing-rise')).toBeNull()
  })
})
