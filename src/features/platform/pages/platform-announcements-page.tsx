import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Pencil, Trash2 } from 'lucide-react'
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
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  createPlatformAnnouncement,
  deletePlatformAnnouncement,
  fetchPlatformAnnouncements,
  setPlatformAnnouncementPublished,
  updatePlatformAnnouncement,
  type PlatformAnnouncement,
} from '@/features/platform/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { formatDateTime } from '@/lib/format'
import { focusFirstInvalid } from '@/lib/form-focus'

/** The composer writes a new announcement, or edits one already written. */
type Composing = { mode: 'new' } | { mode: 'edit'; announcement: PlatformAnnouncement }

/**
 * Platform announcements: notices from RecoverEase itself, for everyone
 * signed in, in every clinic. A clinic's own announcements are its Clinic
 * Admin's and do not appear here; nor can these be touched from a clinic.
 *
 * Saved as a draft until published, and a draft reaches no one. Deleting
 * asks first and cannot be undone; withdrawing keeps the text.
 */
export function PlatformAnnouncementsPage() {
  const queryKeys = useQueryKeys()
  useDocumentTitle('Platform Announcements')
  const queryClient = useQueryClient()
  const focusRecovery = useFocusRecovery()

  const [composing, setComposing] = useState<Composing | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [problems, setProblems] = useState<{
    title?: string | undefined
    content?: string | undefined
  }>({})
  const [pendingDelete, setPendingDelete] =
    useState<PlatformAnnouncement | null>(null)

  const announcementsQuery = useQuery({
    queryKey: queryKeys.platform.announcements(),
    queryFn: fetchPlatformAnnouncements,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.platform.announcements(),
    })

  const closeComposer = () => setComposing(null)

  const save = useMutation({
    mutationFn: async (input: { publish: boolean }) => {
      if (composing?.mode === 'edit') {
        await updatePlatformAnnouncement({
          announcementId: composing.announcement.announcement_id,
          title: title.trim(),
          content: content.trim(),
        })
        return
      }
      await createPlatformAnnouncement({
        title: title.trim(),
        content: content.trim(),
        publish: input.publish,
      })
    },
    onSuccess: () => {
      closeComposer()
      setTitle('')
      setContent('')
      void invalidate()
    },
  })

  // One press, one announcement - the same guard the clinic composer has,
  // for the same reason: the other button stays live while one saves.
  const inFlight = useRef(false)

  const togglePublished = useMutation({
    mutationFn: (input: { id: string; published: boolean }) =>
      setPlatformAnnouncementPublished(input.id, input.published),
    onSuccess: () => void invalidate(),
  })

  const remove = useMutation({
    mutationFn: (announcementId: string) =>
      deletePlatformAnnouncement(announcementId),
    onSuccess: () => {
      setPendingDelete(null)
      void invalidate()
    },
  })

  const submit = (publish: boolean, event: MouseEvent<HTMLButtonElement>) => {
    const next = {
      title: title.trim() ? undefined : 'Give the announcement a title.',
      content: content.trim() ? undefined : 'Write the message.',
    }
    flushSync(() => setProblems(next))
    if (next.title || next.content) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }

    if (inFlight.current) return
    inFlight.current = true
    save.mutate(
      { publish },
      {
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  const openComposer = (next: Composing) => {
    setProblems({})
    save.reset()
    setTitle(next.mode === 'edit' ? next.announcement.announcement_title : '')
    setContent(next.mode === 'edit' ? next.announcement.announcement_content : '')
    setComposing(next)
  }

  const isEditing = composing?.mode === 'edit'

  return (
    <>
      <div ref={focusRecovery}>
        <PageHeader
          title="Platform announcements"
          description="Notices from RecoverEase to everyone signed in, in every clinic. A draft is seen by no one until you publish it."
          actions={
            <Button
              className="max-sm:w-full"
              onClick={() => openComposer({ mode: 'new' })}
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
              <EmptyState
                icon={Megaphone}
                title="No platform announcements yet"
                description="Write one to tell every clinic about the platform itself - planned maintenance, say."
              />
            </Card>
          }
        >
          {(announcements) => (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-[var(--color-border)]">
                {announcements.map((announcement) => {
                  const publishedAt = announcement.announcement_published_at
                  const isPublished = publishedAt !== null

                  return (
                    <li key={announcement.announcement_id}>
                      <article className="px-4 py-5 sm:px-5">
                        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                          <div className="min-w-0">
                            <h2 className="text-balance text-base font-semibold text-heading">
                              {announcement.announcement_title}
                            </h2>
                            <p className="mt-0.5 text-sm text-muted">
                              {publishedAt
                                ? `Published ${formatDateTime(publishedAt)}`
                                : `Draft, created ${formatDateTime(announcement.announcement_created_at)}`}
                            </p>
                          </div>
                          <Badge
                            tone={isPublished ? 'success' : 'neutral'}
                            className="ms-auto shrink-0"
                          >
                            {isPublished ? 'Published' : 'Draft'}
                          </Badge>
                        </div>

                        <p className="mt-3 max-w-prose whitespace-pre-wrap text-pretty leading-relaxed text-body">
                          {announcement.announcement_content}
                        </p>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            isLoading={
                              togglePublished.isPending &&
                              togglePublished.variables?.id ===
                                announcement.announcement_id
                            }
                            // Named with the announcement, the visible words
                            // first (WCAG 2.5.3).
                            aria-label={`${isPublished ? 'Withdraw' : 'Publish now'}: ${announcement.announcement_title}`}
                            onClick={() =>
                              togglePublished.mutate({
                                id: announcement.announcement_id,
                                published: !isPublished,
                              })
                            }
                          >
                            {isPublished ? 'Withdraw' : 'Publish now'}
                          </Button>

                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Edit: ${announcement.announcement_title}`}
                            onClick={() =>
                              openComposer({ mode: 'edit', announcement })
                            }
                          >
                            <Pencil aria-hidden="true" />
                            Edit
                          </Button>

                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete: ${announcement.announcement_title}`}
                            onClick={() => {
                              remove.reset()
                              setPendingDelete(announcement)
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            Delete
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
                                  ? 'The announcement was not withdrawn'
                                  : 'The announcement was not published'
                              }
                            />
                          </div>
                        ) : null}
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
        isOpen={composing !== null}
        onClose={closeComposer}
        title={isEditing ? 'Edit announcement' : 'New platform announcement'}
        description={
          isEditing
            ? 'Changes show wherever it is already published.'
            : 'Save it as a draft, or publish it to every clinic straight away.'
        }
        footer={
          isEditing ? (
            <>
              <Button variant="ghost" onClick={closeComposer}>
                Cancel
              </Button>
              <Button
                isLoading={save.isPending}
                loadingLabel="Saving…"
                onClick={(event) => submit(false, event)}
              >
                Save changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={closeComposer}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                isLoading={save.isPending && save.variables?.publish === false}
                onClick={(event) => submit(false, event)}
              >
                Save as draft
              </Button>
              <Button
                isLoading={save.isPending && save.variables?.publish === true}
                onClick={(event) => submit(true, event)}
              >
                Publish now
              </Button>
            </>
          )
        }
      >
        <div className="space-y-4">
          <Field label="Title" required error={problems.title}>
            <Input
              value={title}
              maxLength={150}
              onChange={(event) => {
                setTitle(event.target.value)
                setProblems((current) => ({ ...current, title: undefined }))
              }}
            />
          </Field>

          <Field label="Message" required error={problems.content}>
            <Textarea
              rows={6}
              maxLength={5000}
              value={content}
              onChange={(event) => {
                setContent(event.target.value)
                setProblems((current) => ({ ...current, content: undefined }))
              }}
            />
          </Field>

          {save.isError ? (
            <FormError
              error={save.error}
              title={
                isEditing
                  ? 'Your changes were not saved'
                  : 'The announcement was not saved'
              }
            />
          ) : null}
        </div>
      </Dialog>

      {/* --- Delete confirmation ------------------------------------------- */}
      <Dialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete this announcement?"
        description="This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              isLoading={remove.isPending}
              loadingLabel="Deleting…"
              onClick={() =>
                pendingDelete && remove.mutate(pendingDelete.announcement_id)
              }
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-body">
          It will be removed for every clinic. To hide it but keep the text,
          withdraw it instead. The platform audit log keeps a record of what
          it said.
        </p>
        {remove.isError ? (
          <div className="mt-4">
            <FormError
              error={remove.error}
              title="The announcement was not deleted"
            />
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
