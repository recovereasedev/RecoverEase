import { useQuery } from '@tanstack/react-query'
import { Megaphone } from 'lucide-react'

import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Card } from '@/components/ui/card'
import { fetchAnnouncements } from '@/features/announcements/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateRelative } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * Module 7.4 "View System Announcements".
 *
 * Only published announcements reach a non-administrator: the RLS policy
 * filters drafts out, so an unfinished notice cannot be read early by
 * guessing a URL.
 */
export function AnnouncementsPage() {
  useDocumentTitle('Announcements')
  const announcementsQuery = useQuery({
    queryKey: queryKeys.announcements.list(),
    queryFn: fetchAnnouncements,
  })

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Notices from your clinic."
      />

      <StateView
        isPending={announcementsQuery.isPending}
        error={announcementsQuery.error}
        data={announcementsQuery.data}
        onRetry={() => void announcementsQuery.refetch()}
        empty={
          <Card className="max-w-2xl">
            <EmptyState
              icon={Megaphone}
              title="No announcements"
              description="Notices from your clinic will appear here."
            />
          </Card>
        }
      >
        {(announcements) => (
          /* One list, divided by hairlines, rather than a card per notice: a
             page of notices is one thing to read, and a stack of separate
             boxes made each one look like a separate task. Set in a reading
             column rather than across the page, because a notice is prose. */
          <Card className="max-w-2xl overflow-hidden">
            <ul className="divide-y divide-[var(--color-border)]">
              {announcements.map((announcement) => {
                const published = announcement.announcement_published_at
                return (
                  <li key={announcement.announcement_id}>
                    {/* Each notice is a small article: a heading, when it was
                        posted, then what it says - read in that order, and
                        announced that way too. */}
                    <article className="px-4 py-5 sm:px-5 sm:py-6">
                      <h2 className="text-balance text-headline-md text-heading">
                        {announcement.announcement_title}
                      </h2>
                      <p className="mt-1 text-sm text-muted">
                        {published ? (
                          // "Today", "Yesterday", then the dated day: how
                          // recent it is, which is what makes a notice worth
                          // reading first.
                          <time dateTime={published}>
                            {formatDateRelative(published)}
                          </time>
                        ) : (
                          'Not yet published'
                        )}
                      </p>
                      {/* A measure, not a column width: a notice set across a
                          1000px card is a line nobody reads twice. */}
                      <p className="mt-3 max-w-prose whitespace-pre-wrap text-pretty leading-relaxed text-body">
                        {announcement.announcement_content}
                      </p>
                    </article>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}
      </StateView>
    </>
  )
}
