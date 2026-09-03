import { useQuery } from '@tanstack/react-query'
import { Megaphone } from 'lucide-react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Card, CardBody } from '@/components/ui/card'
import { fetchAnnouncements } from '@/features/announcements/api'
import { formatDate } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * Module 7.4 "View System Announcements".
 *
 * Only published announcements reach a non-administrator: the RLS policy
 * filters drafts out, so an unfinished notice cannot be read early by
 * guessing a URL.
 */
export function AnnouncementsPage() {
  const announcementsQuery = useQuery({
    queryKey: queryKeys.announcements.list(),
    queryFn: fetchAnnouncements,
  })

  return (
    <>
      <PageHeader
        eyebrow="From your clinic"
        title="Announcements"
        description="Notices from your clinic."
      />

      <StateView
        isPending={announcementsQuery.isPending}
        error={announcementsQuery.error}
        data={announcementsQuery.data}
        onRetry={() => void announcementsQuery.refetch()}
        empty={
          <Card>
            <CardBody>
              <div className="py-10 text-center">
                <Megaphone
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  No announcements
                </p>
                <p className="mt-1 text-sm text-muted">
                  Notices from your clinic will appear here.
                </p>
              </div>
            </CardBody>
          </Card>
        }
      >
        {(announcements) => (
          <div className="space-y-4">
            {announcements.map((announcement) => (
              <Card key={announcement.announcement_id}>
                <CardBody>
                  <h2 className="text-headline-md text-heading">
                    {announcement.announcement_title}
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    {announcement.announcement_published_at
                      ? formatDate(announcement.announcement_published_at)
                      : 'Not yet published'}
                  </p>
                  <p className="mt-3 whitespace-pre-wrap leading-relaxed text-body">
                    {announcement.announcement_content}
                  </p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </StateView>
    </>
  )
}
