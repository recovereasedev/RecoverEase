import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type Announcement = Tables<'announcement'>

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
 * Module 7.4 "View System Announcements" for everyone; module 12 for
 * administrators.
 *
 * Drafts are filtered by the RLS policy, not here: a non-admin sees only rows
 * where `announcement_published_at` is set. An administrator gets their
 * drafts too, from the same call. Published platform announcements come back
 * with the clinic's own (`isPlatformAnnouncement`).
 */
export async function fetchAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcement')
    .select('*')
    .order('announcement_created_at', { ascending: false })

  if (error) throw error
  return data
}

/** Module 12.1 "Create Announcement". */
export async function createAnnouncement(input: {
  adminId: string
  title: string
  content: string
  publishNow: boolean
}): Promise<Announcement> {
  const { data, error } = await supabase
    .from('announcement')
    .insert({
      admin_id: input.adminId,
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
