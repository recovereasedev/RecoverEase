import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Trash2 } from 'lucide-react'
import { useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncements,
  isPlatformAnnouncement,
  setAnnouncementPublished,
  type AnnouncementAuthor,
  type ListedAnnouncement,
} from '@/features/announcements/api'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { formatDateTime } from '@/lib/format'
import { focusFirstInvalid } from '@/lib/form-focus'
import { queryKeys } from '@/lib/query-keys'

export type AnnouncementBoardProps = {
  /** Who a new announcement is written as. */
  author: AnnouncementAuthor
  /**
   * Whether this person may publish, unpublish and delete it. Every other
   * announcement is shown read-only, with where it is from - the database
   * would refuse the change anyway, by changing nothing.
   */
  canManage: (announcement: ListedAnnouncement) => boolean
  /**
   * Who an announcement reaches, or who wrote it, under its date - for
   * instance a doctor's, which reaches only their patients. Nothing when
   * the page has nothing to add.
   */
  audienceOf?: (announcement: ListedAnnouncement) => string | null
  description: string
  emptyDescription: string
  /** Under the composer's title. */
  composerNote?: string
}

/**
 * Modules 12.1 "Create Announcement" and 12.2 "Manage / Delete Announcement",
 * for whoever writes a clinic's announcements: its Clinic Admin, and its
 * doctors (migration 36).
 *
 * An announcement is saved as a draft until published, so a half-written
 * notice is never visible to patients — the RLS policy hides unpublished rows
 * from everyone but administrators and the doctor who wrote it.
 *
 * Deletion asks for confirmation. It cannot be undone.
 *
 * Published platform announcements - RecoverEase's, written by a Super Admin
 * - are listed too, marked as RecoverEase's and never with Publish or Delete:
 * only a Super Admin can change those. So is a Clinic Admin's announcement
 * on a doctor's page, marked as their clinic's.
 */
export function AnnouncementBoard({
  author,
  canManage,
  audienceOf,
  description,
  emptyDescription,
  composerNote = 'Save it as a draft, or publish it straight away.',
}: AnnouncementBoardProps) {
  const queryClient = useQueryClient()

  const [isComposerOpen, setComposerOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [problems, setProblems] = useState<{
    title?: string | undefined
    content?: string | undefined
  }>({})
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const focusRecovery = useFocusRecovery()

  const announcementsQuery = useQuery({
    queryKey: queryKeys.announcements.list(),
    queryFn: fetchAnnouncements,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.announcements.all })

  const create = useMutation({
    mutationFn: (publishNow: boolean) =>
      createAnnouncement({
        author,
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

  // One press, one announcement. `isLoading` ignores presses only on the
  // button that is saving: the composer's other button stayed live and sent
  // a second request, which left a draft and a published copy of the same
  // notice. Two presses in the same task also both got through, because
  // React commits the busy button on a later render and React Query does not
  // deduplicate concurrent `mutate()` calls.
  const inFlight = useRef(false)

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

  // Both buttons are always pressable. An announcement needs a title and a
  // message - the same two the buttons used to wait for - and what is missing
  // is said beside its field, with focus taken there, before anything is sent.
  const submit = (publishNow: boolean, event: MouseEvent<HTMLButtonElement>) => {
    const next = {
      title: title.trim() ? undefined : 'Give the announcement a title.',
      content: content.trim() ? undefined : 'Write the message.',
    }
    flushSync(() => setProblems(next))
    if (next.title || next.content) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }

    // Nothing below this line may run twice for one announcement.
    if (inFlight.current) return
    inFlight.current = true

    create.mutate(publishNow, {
      // Released however it ends, so a genuine failure can be retried and
      // the composer is never left permanently locked.
      onSettled: () => {
        inFlight.current = false
      },
    })
  }

  const openComposer = () => {
    setProblems({})
    setComposerOpen(true)
  }

  return (
    <>
      {/* "Delete permanently" hands focus back to the Delete it came from,
          which then leaves with its announcement: keyboard focus moves on to
          the next announcement's controls, or back to "New announcement".
          A plain block around the header and the list, so both are in it. */}
      <div ref={focusRecovery}>
        <PageHeader
          title="Announcements"
          description={description}
          actions={
            <Button className="max-sm:w-full" onClick={openComposer}>
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
              <EmptyState
                icon={Megaphone}
                title="No announcements yet"
                description={emptyDescription}
              />
            </Card>
          }
        >
          {(announcements) => (
            /* One list, divided by hairlines, the way patients read these
               same notices: a card per notice, each cut into three bands by
               its header and its actions, turned a page of short notices into
               a stack of separate boxes. The text keeps the patient page's
               reading measure, so a notice is checked at the width it is read
               at rather than across the whole page. */
            <Card className="overflow-hidden">
              <ul className="divide-y divide-[var(--color-border)]">
                {announcements.map((announcement) => {
                  const isPublished = Boolean(announcement.announcement_published_at)
                  const manageable = canManage(announcement)
                  const fromRecoverEase = isPlatformAnnouncement(announcement)
                  const audience = audienceOf?.(announcement) ?? null

                  return (
                    <li key={announcement.announcement_id}>
                      <article className="px-4 py-5 sm:px-5">
                        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                          <div className="min-w-0">
                            <h2 className="text-balance text-base font-semibold text-heading">
                              {announcement.announcement_title}
                            </h2>
                            <p className="mt-0.5 text-sm text-muted">
                              {isPublished
                                ? `Published ${formatDateTime(announcement.announcement_published_at as string)}`
                                : `Draft, created ${formatDateTime(announcement.announcement_created_at)}`}
                            </p>
                            {audience ? (
                              <p className="mt-0.5 text-sm text-muted">{audience}</p>
                            ) : null}
                          </div>
                          {manageable ? (
                            <Badge
                              tone={isPublished ? 'success' : 'neutral'}
                              className="ms-auto shrink-0"
                            >
                              {isPublished ? 'Published' : 'Draft'}
                            </Badge>
                          ) : (
                            <Badge tone="info" className="ms-auto shrink-0">
                              {fromRecoverEase ? 'From RecoverEase' : 'From your clinic'}
                            </Badge>
                          )}
                        </div>

                        <p className="mt-3 max-w-prose whitespace-pre-wrap text-pretty leading-relaxed text-body">
                          {announcement.announcement_content}
                        </p>

                        {!manageable ? (
                          // Read here, never managed: no button the database
                          // would refuse.
                          <p className="mt-4 text-sm text-muted">
                            {fromRecoverEase
                              ? 'Only RecoverEase can change or remove this notice.'
                              : 'Only your Clinic Admin can change or remove this notice.'}
                          </p>
                        ) : (
                          <>
                            {/* Publish and Delete are not alternatives to each
                                other, so they are not given equal width: the
                                destructive one stays a quiet ghost button beside
                                the one an administrator actually came here to
                                press. */}
                            <div className="mt-4 flex flex-wrap gap-2">
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

                            {togglePublished.isError &&
                            togglePublished.variables?.id ===
                              announcement.announcement_id ? (
                              <div className="mt-3">
                                <FormError
                                  error={togglePublished.error}
                                  title={
                                    isPublished
                                      ? 'The announcement was not unpublished'
                                      : 'The announcement was not published'
                                  }
                                />
                              </div>
                            ) : null}
                          </>
                        )}
                      </article>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}
        </StateView>
      </div>

      {/* --- Composer ----------------------------------------------------- */}
      <Dialog
        isOpen={isComposerOpen}
        onClose={() => setComposerOpen(false)}
        title="New announcement"
        description={composerNote}
        footer={
          <>
            <Button variant="ghost" onClick={() => setComposerOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              isLoading={create.isPending && create.variables === false}
              onClick={(event) => submit(false, event)}
            >
              Save as draft
            </Button>
            <Button
              isLoading={create.isPending && create.variables === true}
              onClick={(event) => submit(true, event)}
            >
              Publish now
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Title" required error={problems.title}>
            <Input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
                setProblems((current) => ({ ...current, title: undefined }))
              }}
              placeholder="Clinic closed on public holidays"
            />
          </Field>

          <Field label="Message" required error={problems.content}>
            <Textarea
              rows={6}
              value={content}
              onChange={(event) => {
                setContent(event.target.value)
                setProblems((current) => ({ ...current, content: undefined }))
              }}
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
