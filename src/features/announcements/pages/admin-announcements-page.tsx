import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncements,
  setAnnouncementPublished,
} from '@/features/announcements/api'
import { useCurrentUser } from '@/features/auth/auth-context'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * Modules 12.1 "Create Announcement" and 12.2 "Manage / Delete Announcement".
 *
 * An announcement is saved as a draft until published, so a half-written
 * notice is never visible to patients — the RLS policy hides unpublished rows
 * from everyone but administrators.
 *
 * Deletion asks for confirmation. It is the only destructive action in the
 * administrator's interface and it cannot be undone.
 */
export function AdminAnnouncementsPage() {
  const user = useCurrentUser()
  const adminId = user.profile.kind === 'admin' ? user.profile.admin.admin_id : ''
  const queryClient = useQueryClient()

  const [isComposerOpen, setComposerOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const announcementsQuery = useQuery({
    queryKey: queryKeys.announcements.list(),
    queryFn: fetchAnnouncements,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.announcements.all })

  const create = useMutation({
    mutationFn: (publishNow: boolean) =>
      createAnnouncement({
        adminId,
        title: title.trim(),
        content: content.trim(),
        publishNow,
      }),
    onSuccess: () => {
      setComposerOpen(false)
      setTitle('')
      setContent('')
      void invalidate()
    },
  })

  const togglePublished = useMutation({
    mutationFn: (input: { id: string; isPublished: boolean }) =>
      setAnnouncementPublished(input.id, input.isPublished),
    onSuccess: () => void invalidate(),
  })

  const remove = useMutation({
    mutationFn: deleteAnnouncement,
    onSuccess: () => {
      setPendingDeleteId(null)
      void invalidate()
    },
  })

  const canSubmit = title.trim().length > 0 && content.trim().length > 0

  return (
    <>
      <PageHeader
        eyebrow="Communication"
        title="Announcements"
        description="Notices shown to everyone using RecoverEase."
        actions={
          <Button
            className="max-sm:w-full"
            onClick={() => setComposerOpen(true)}
          >
            <Megaphone aria-hidden="true" />
            New announcement
          </Button>
        }
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
                  No announcements yet
                </p>
                <p className="mt-1 text-sm text-muted">
                  Create one to notify everyone using the system.
                </p>
              </div>
            </CardBody>
          </Card>
        }
      >
        {(announcements) => (
          <div className="space-y-4">
            {announcements.map((announcement) => {
              const isPublished = Boolean(announcement.announcement_published_at)

              return (
                <Card key={announcement.announcement_id}>
                  <CardHeader
                    icon={Megaphone}
                    title={announcement.announcement_title}
                    description={
                      isPublished
                        ? `Published ${formatDateTime(announcement.announcement_published_at as string)}`
                        : `Draft, created ${formatDateTime(announcement.announcement_created_at)}`
                    }
                    action={
                      <Badge tone={isPublished ? 'success' : 'neutral'}>
                        {isPublished ? 'Published' : 'Draft'}
                      </Badge>
                    }
                  />
                  <CardBody>
                    <p className="whitespace-pre-wrap leading-relaxed text-body">
                      {announcement.announcement_content}
                    </p>

                    {/* Publish and Delete are not alternatives to each
                        other, so they are not given equal width: the
                        destructive one stays a quiet ghost button beside the
                        one an administrator actually came here to press. */}
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
                      <Button
                        size="sm"
                        variant="secondary"
                        isLoading={
                          togglePublished.isPending &&
                          togglePublished.variables?.id ===
                            announcement.announcement_id
                        }
                        onClick={() =>
                          togglePublished.mutate({
                            id: announcement.announcement_id,
                            isPublished: !isPublished,
                          })
                        }
                      >
                        {isPublished ? 'Unpublish' : 'Publish now'}
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPendingDeleteId(announcement.announcement_id)
                        }
                      >
                        <Trash2 aria-hidden="true" />
                        Delete
                        <span className="sr-only">
                          : {announcement.announcement_title}
                        </span>
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              )
            })}
          </div>
        )}
      </StateView>

      {/* --- Composer ----------------------------------------------------- */}
      <Dialog
        isOpen={isComposerOpen}
        onClose={() => setComposerOpen(false)}
        title="New announcement"
        description="Save it as a draft, or publish it straight away."
        footer={
          <>
            <Button variant="ghost" onClick={() => setComposerOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={!canSubmit}
              isLoading={create.isPending && create.variables === false}
              onClick={() => create.mutate(false)}
            >
              Save as draft
            </Button>
            <Button
              disabled={!canSubmit}
              isLoading={create.isPending && create.variables === true}
              onClick={() => create.mutate(true)}
            >
              Publish now
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Title" required>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Clinic closed on public holidays"
            />
          </Field>

          <Field label="Message" required>
            <Textarea
              rows={6}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="The clinic will be closed on…"
            />
          </Field>

          {create.isError ? (
            <FormError
              error={create.error}
              title="The announcement was not posted"
            />
          ) : null}
        </div>
      </Dialog>

      {/* --- Delete confirmation ------------------------------------------- */}
      <Dialog
        isOpen={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        title="Delete this announcement?"
        description="This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDeleteId(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              isLoading={remove.isPending}
              onClick={() =>
                pendingDeleteId && remove.mutate(pendingDeleteId)
              }
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-body">
          The announcement will be removed for everyone. If you only want to
          hide it, unpublish it instead — that keeps the text so you can
          publish it again later.
        </p>
        {remove.isError ? (
          <FormError
            error={remove.error}
            title="The announcement was not deleted"
          />
        ) : null}
      </Dialog>
    </>
  )
}
