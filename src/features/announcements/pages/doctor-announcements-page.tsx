import { AnnouncementBoard } from '@/features/announcements/components/announcement-board'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useDocumentTitle } from '@/hooks/use-document-title'

/**
 * A doctor's announcements (migration 36).
 *
 * A doctor writes announcements for their own patients: once published, one
 * reaches the patients assigned to them now, and no one else - not their
 * colleagues, not another doctor's patients. They also read their Clinic
 * Admin's announcements and RecoverEase's, read-only. They publish, unpublish
 * and delete only the ones they wrote, and the database refuses a doctor any
 * other change.
 */
export function DoctorAnnouncementsPage() {
  useDocumentTitle('Announcements')
  const user = useCurrentUser()
  const doctorId = user.profile.kind === 'doctor' ? user.profile.doctor.doc_id : ''
  const isMine = (docId: string | null) => doctorId !== '' && docId === doctorId

  return (
    <AnnouncementBoard
      author={{ doctorId }}
      canManage={(announcement) => isMine(announcement.doc_id)}
      audienceOf={(announcement) => (isMine(announcement.doc_id) ? 'For your patients' : null)}
      description="Your notices for your patients, with your Clinic Admin's and RecoverEase's. You can change the ones you wrote."
      emptyDescription="Create one to notify your patients."
      composerNote="It reaches your patients only. Keep it to practical notices, such as clinic hours or leave - nothing about one patient's care."
    />
  )
}
