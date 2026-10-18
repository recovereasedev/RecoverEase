import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type Announcement = Tables<'announcement'>

/**
 * An announcement as the lists read it: with its doctor author's name, when
 * a doctor wrote it and the reader may see that doctor - their Clinic Admin,
 * the doctor themselves, or the doctor's own patient. Empty otherwise.
 */
export type ListedAnnouncement = Announcement & {
  doctor: Pick<Tables<'doctor'>, 'doc_first_name' | 'doc_last_name'> | null
}

/**
 * A platform announcement: written by a Super Admin for everyone on
 * RecoverEase (migration 33), not by a Clinic Admin for their clinic. Clinic
 * screens show it but cannot change it - the database lets only a Super
 * Admin, through their own functions, do that.
 */
export function isPlatformAnnouncement(announcement: Announcement): boolean {
  return Boolean(announcement.super_admin_id)
}

/**
 * A doctor's announcement, for the patients assigned to them (migration 36),
 * rather than a Clinic Admin's for the whole clinic.
 */
export function isDoctorAnnouncement(announcement: Announcement): boolean {
  return Boolean(announcement.doc_id)
}

/**
 * Module 7.4 "View System Announcements" for everyone; module 12 for
 * administrators.
 *
 * Who sees which is the RLS policy's decision, not this function's: a
 * patient gets the published platform ones, their clinic's Clinic Admin's,
 * and their own active doctor's; a doctor gets the platform's, their Clinic
 * Admin's and their own, drafts included; a Clinic Admin every one of their
 * clinic's, drafts included, and the platform's.
 */
export async function fetchAnnouncements(): Promise<ListedAnnouncement[]> {
  const { data, error } = await supabase
    .from('announcement')
    .select('*, doctor ( doc_first_name, doc_last_name )')
    .order('announcement_created_at', { ascending: false })

  if (error) throw error
  return data
}

/**
 * Who writes a clinic announcement: its Clinic Admin, or one of its doctors
 * (migration 36). Never a Super Admin - theirs go through their own
 * functions. The clinic is not sent: the database takes it from the author.
 */
export type AnnouncementAuthor = { adminId: string } | { doctorId: string }

/** Module 12.1 "Create Announcement". */
export async function createAnnouncement(input: {
  author: AnnouncementAuthor
  title: string
  content: string
  publishNow: boolean
}): Promise<Announcement> {
  const { data, error } = await supabase
    .from('announcement')
    .insert({
      ...('adminId' in input.author
        ? { admin_id: input.author.adminId }
        : { doc_id: input.author.doctorId }),
      announcement_title: input.title,
      announcement_content: input.content,
      announcement_published_at: input.publishNow
        ? new Date().toISOString()
        : null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/** Module 12.2 "Manage / Delete Announcement" — the publish half. */
export async function setAnnouncementPublished(
  announcementId: string,
  isPublished: boolean,
): Promise<void> {
  const { data, error } = await supabase
    .from('announcement')
    .update({
      announcement_published_at: isPublished
        ? new Date().toISOString()
        : null,
    })
    .eq('announcement_id', announcementId)
    .select('announcement_id')

  if (error) throw error
  // RLS refuses an update by matching no row rather than by raising - a
  // platform announcement, another clinic's, or one already deleted. Saying
  // it changed when nothing did would be worse than failing.
  if (!data || data.length === 0) {
    throw new Error(
      'This announcement was not changed. It may have been deleted already, or it is not one your clinic can change.',
    )
  }
}

/** Module 12.2 — the delete half. */
export async function deleteAnnouncement(
  announcementId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('announcement')
    .delete()
    .eq('announcement_id', announcementId)
    .select('announcement_id')

  if (error) throw error
  // As above: a refused delete removes no row and raises nothing.
  if (!data || data.length === 0) {
    throw new Error(
      'This announcement was not deleted. It may have been deleted already, or it is not one your clinic can delete.',
    )
  }
}
