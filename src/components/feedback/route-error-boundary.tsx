import { RefreshCw, TriangleAlert } from 'lucide-react'
import { isRouteErrorResponse, useRouteError } from 'react-router-dom'

import { Button } from '@/components/ui/button'

/**
 * Recognises the failure that follows a deployment.
 *
 * Every page in RecoverEase is a lazily imported chunk with a content hash in
 * its filename. When a new version is released the old filenames stop
 * existing, so a browser that still has the previous `index.html` open asks
 * for a chunk that is no longer there and the import rejects. The session is
 * fine and the server is fine — the tab is simply holding a build that has
 * been replaced.
 *
 * Reloading fetches the current `index.html`, and with it the current chunk
 * names, which is why the recovery below is a reload rather than a retry.
 */
function isStaleBuildError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${error.name}`
      : typeof error === 'string'
        ? error
        : ''

  const lowered = message.toLowerCase()

  return (
    lowered.includes('dynamically imported module') ||
    lowered.includes('failed to fetch dynamically') ||
    lowered.includes('error loading dynamically imported module') ||
    lowered.includes('importing a module script failed') ||
    // Safari's wording for the same condition.
    lowered.includes('module script failed')
  )
}

/**
 * The router's `errorElement`.
 *
 * Without one, React Router renders its own developer screen — the "Hey
 * developer 👋" page, which shows a raw stack trace to whoever is holding the
 * device. On a clinical system that is both alarming and useless: a patient
 * cannot act on `TypeError: Failed to fetch dynamically imported module`.
 *
 * Errors are not reported to an external service here, deliberately. A route
 * error can carry a URL containing a patient identifier, and RecoverEase has
 * no data-processing agreement with a third-party error collector.
 */
export function RouteErrorBoundary() {
  const error = useRouteError()

  if (isStaleBuildError(error)) {
    return (
      <div
        role="alert"
        className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      >
        <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-brand-50">
          <RefreshCw className="size-5 text-brand-700" aria-hidden="true" />
        </span>
        <h1 className="text-headline-md text-heading">
          RecoverEase has been updated
        </h1>
        <p className="max-w-sm text-body-md text-muted">
          A new version was released while this page was open. Reload to
          continue — nothing you have saved is affected.
        </p>
        <Button
          className="mt-3 max-sm:w-full"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </Button>
      </div>
    )
  }

  const status = isRouteErrorResponse(error) ? error.status : null

  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    >
      <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-danger-50">
        <TriangleAlert className="size-5 text-danger-700" aria-hidden="true" />
      </span>
      <h1 className="text-headline-md text-heading">Something went wrong</h1>
      <p className="max-w-sm text-body-md text-muted">
        {status === 404
          ? 'That page could not be found.'
          : 'This page could not be displayed. Reloading usually helps. If it keeps happening, contact your care team.'}
      </p>
      <Button
        className="mt-3 max-sm:w-full"
        onClick={() => window.location.reload()}
      >
        Reload the page
      </Button>
    </div>
  )
}
