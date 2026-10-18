import {
  isDoctorAnnouncement,
  isPlatformAnnouncement,
  type ListedAnnouncement,
} from '@/features/announcements/api'
import { AnnouncementBoard } from '@/features/announcements/components/announcement-board'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { fullName } from '@/lib/utils'

/** Who wrote a doctor's announcement, and whom it reaches. */
function doctorAudience(announcement: ListedAnnouncement): string | null {
  if (!isDoctorAnnouncement(announcement)) return null
  const doctor = announcement.doctor
  const author = doctor ? `Dr ${fullName(doctor.doc_first_name, doctor.doc_last_name)}` : 'A doctor'
  return `By ${author}, for their patients`
}

/**
 * Modules 12.1 "Create Announcement" and 12.2 "Manage / Delete Announcement"
 * for a Clinic Admin.
 *
 * A Clinic Admin's announcements reach the people in their clinic, and they
 * manage every announcement of their clinic - their doctors' too, each named
 * with the doctor who wrote it, since a doctor's reaches only that doctor's
 * patients (migration 36). A published platform announcement is listed with
 * them, marked as RecoverEase's and without Publish or Delete: only a Super
 * Admin can change those, and the database refuses anyone else.
 */
export function AdminAnnouncementsPage() {
  useDocumentTitle('Announcements')
  const user = useCurrentUser()
  const adminId = user.profile.kind === 'admin' ? user.profile.admin.admin_id : ''

  return (
    <AnnouncementBoard
      author={{ adminId }}
      canManage={(announcement) => !isPlatformAnnouncement(announcement)}
      audienceOf={doctorAudience}
      description="Notices for everyone in your clinic, your doctors' notices for their patients, and any notices from RecoverEase."
      emptyDescription="Create one to notify everyone in your clinic."
    />
  )
}
