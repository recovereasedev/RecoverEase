import { Bell, LogOut, Menu, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'

import {
  navigationFor,
  primaryMobileNavFor,
  type NavItem,
} from '@/app/routes/navigation'
import { BrandLockup, BrandWordmark } from '@/components/layout/brand'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { useUnreadNotificationCount } from '@/features/notifications/hooks'
import type { UserRole } from '@/features/auth/types'
import { cn, initialsFromName } from '@/lib/utils'

const ROLE_LABEL: Record<UserRole, string> = {
  patient: 'Patient',
  doctor: 'Clinician',
  admin: 'Administrator',
}

/**
 * The line under the wordmark, and the context pill in the header.
 *
 * This is the only "where am I" cue the shell shows, and it is deliberately a
 * fact the application actually holds - which portal you are signed in to.
 * The design comps carry a live clinical status here ("Active Post-Op
 * Pathway"); RecoverEase has no such concept, and inventing one would put a
 * fabricated clinical claim in the frame of every screen.
 */
const ROLE_CONTEXT: Record<UserRole, string> = {
  patient: 'Patient care portal',
  doctor: 'Clinician workspace',
  admin: 'System administration',
}

function navLinkClasses(isActive: boolean): string {
  return cn(
    'flex items-center gap-3 rounded-[var(--radius-md)] border-l-[3px] px-3 py-2.5 text-sm',
    'transition-colors duration-[var(--duration-fast)]',
    isActive
      ? // The teal left accent is the design system's active marker. It is
        // paired with a tonal fill and a weight change, so the state is not
        // carried by a 3px stripe of colour alone.
        'border-accent-600 bg-surface-raised font-semibold text-brand-800'
      : 'border-transparent font-medium text-body hover:bg-neutral-100 hover:text-heading',
  )
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()
  if (!user) return null

  return (
    <nav aria-label="Main" className="space-y-6">
      {navigationFor(user.role).map((section, index) => (
        <div key={section.heading ?? `section-${index}`}>
          {section.heading ? (
            <h2 className="mb-2 px-3 text-label-sm font-semibold uppercase tracking-wider text-muted">
              {section.heading}
            </h2>
          ) : null}
          <ul className="space-y-1">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={!item.matchPrefix}
                  onClick={onNavigate}
                  className={({ isActive }) => navLinkClasses(isActive)}
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={cn(
                          'size-5 shrink-0',
                          isActive ? 'text-accent-700' : 'text-neutral-500',
                        )}
                        aria-hidden="true"
                      />
                      {item.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function NotificationBell({ to }: { to: string }) {
  const { data: unread = 0 } = useUnreadNotificationCount()

  return (
    <Link
      to={to}
      className="relative inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] text-body transition-colors hover:bg-neutral-100 hover:text-heading"
    >
      <Bell className="size-5" aria-hidden="true" />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-semibold leading-4 text-white"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
      {/* The count is in the accessible name rather than only in the badge,
          so it is announced instead of being a purely visual cue. */}
      <span className="sr-only">
        {unread > 0
          ? `Notifications, ${unread} unread`
          : 'Notifications, none unread'}
      </span>
    </Link>
  )
}

function UserIdentity({
  name,
  role,
  className,
}: {
  name: string
  role: UserRole
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="hidden min-w-0 text-right sm:block">
        <span className="block truncate text-sm font-semibold text-heading">
          {name}
        </span>
        <span className="block truncate text-label-sm text-muted">
          {ROLE_LABEL[role]}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-800 text-xs font-semibold text-white"
      >
        {initialsFromName(name)}
      </span>
    </div>
  )
}

function MobileDrawer({
  isOpen,
  onClose,
  role,
  onSignOut,
}: {
  isOpen: boolean
  onClose: () => void
  role: UserRole
  onSignOut: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!isOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', onKeyDown)
    // Prevent the page behind the drawer from scrolling under it.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Move focus into the drawer so keyboard and screen reader users are
    // taken to the thing that just opened, not left behind it.
    panelRef.current?.querySelector<HTMLElement>('a, button')?.focus()

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-950/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <span id={titleId}>
            <BrandLockup subtitle={ROLE_CONTEXT[role]} />
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav onNavigate={onClose} />
        </div>
        <div className="border-t border-[var(--color-border)] p-3">
          <Button
            variant="ghost"
            block
            className="justify-start text-danger-700 hover:bg-danger-50 hover:text-danger-800"
            onClick={onSignOut}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}

function BottomNav({ items }: { items: NavItem[] }) {
  return (
    <nav
      aria-label="Primary"
      // The bottom padding keeps the bar clear of the iOS home indicator.
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border)] bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={!item.matchPrefix}
              className={({ isActive }) =>
                cn(
                  'flex h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium',
                  isActive ? 'text-brand-800' : 'text-muted',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'flex h-7 w-12 items-center justify-center rounded-full transition-colors',
                      isActive ? 'bg-surface-raised' : 'bg-transparent',
                    )}
                  >
                    <item.icon
                      className={cn(
                        'size-5',
                        isActive ? 'text-brand-800' : 'text-neutral-500',
                      )}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="line-clamp-1">
                    {item.shortLabel ?? item.label}
                  </span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function AppShell() {
  const { user, signOut } = useAuth()
  const [isMenuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  // Close the drawer on navigation. Clicking a link inside it already closes
  // it directly; this covers the case the click handler cannot see — the
  // browser's own back and forward buttons, which change the route without
  // any React event. That is external-system synchronisation, so the effect
  // is the right tool rather than a smell.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setMenuOpen(false)
  }, [location.pathname])

  if (!user) return null

  const notificationsHref = `/${user.role}/notifications`
  const mobileItems = primaryMobileNavFor(user.role)
  const handleSignOut = () => void signOut()

  return (
    <div className="min-h-dvh bg-canvas">
      <a
        href="#main-content"
        className="sr-only-focusable absolute left-4 top-4 z-[60] rounded-[var(--radius-md)] bg-brand-800 px-4 py-2 text-sm font-medium text-white"
      >
        Skip to main content
      </a>

      {/* --- Desktop sidebar --------------------------------------------- */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-sidebar lg:flex-col lg:border-r lg:border-[var(--color-border)] lg:bg-surface">
        <div className="flex h-20 items-center border-b border-[var(--color-border)] px-5">
          <Link
            to={`/${user.role}`}
            className="min-w-0 rounded-[var(--radius-sm)]"
          >
            <BrandLockup subtitle={ROLE_CONTEXT[user.role]} />
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav />
        </div>

        <div className="border-t border-[var(--color-border)] p-3">
          <Button
            variant="ghost"
            block
            className="justify-start text-danger-700 hover:bg-danger-50 hover:text-danger-800"
            onClick={handleSignOut}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>

      <MobileDrawer
        isOpen={isMenuOpen}
        onClose={() => setMenuOpen(false)}
        role={user.role}
        onSignOut={handleSignOut}
      />

      {/* --- Content column ----------------------------------------------- */}
      <div className="lg:pl-sidebar">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-[var(--color-border)] bg-surface/95 px-4 backdrop-blur-sm sm:px-6 lg:h-20">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open menu"
            aria-expanded={isMenuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu aria-hidden="true" />
          </Button>

          <Link to={`/${user.role}`} className="lg:hidden">
            <BrandWordmark />
          </Link>

          {/* Context strip. Hidden on small screens, where the wordmark and
              the bottom bar already say where you are. */}
          <p className="hidden items-center gap-2 rounded-full bg-surface-sunken px-3 py-1.5 text-label-sm font-medium text-muted lg:inline-flex">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-accent-600"
            />
            {ROLE_CONTEXT[user.role]}
          </p>

          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            <NotificationBell to={notificationsHref} />

            <span
              aria-hidden="true"
              className="hidden h-8 w-px bg-[var(--color-border)] sm:block"
            />

            {/* Sign out is not repeated here on a phone: the drawer carries
                it, and a five-control header at 375px leaves every target
                too narrow to hit reliably. */}
            <UserIdentity name={user.displayName} role={user.role} />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          // Capped at the design system's 1280px reading width so line
          // lengths stay readable on an ultra-wide monitor.
          className="content-width px-4 pb-24 pt-6 sm:px-6 md:pb-10 lg:px-8 lg:pt-8"
        >
          <Outlet />
        </main>
      </div>

      <BottomNav items={mobileItems} />
    </div>
  )
}
