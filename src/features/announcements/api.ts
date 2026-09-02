import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type Announcement = Tables<'announcement'>

/**
 * Module 7.4 "View System Announcements" for everyone; module 12 for
 * administrators.
 *
 * Drafts are filtered by the RLS policy, not here: a non-admin sees only rows
 * where `announcement_published_at` is set. An administrator gets their
 * drafts too, from the same call.
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
  const { error } = await supabase
    .from('announcement')
    .update({
      announcement_published_at: isPublished
        ? new Date().toISOString()
        : null,
    })
    .eq('announcement_id', announcementId)

  if (error) throw error
}

/** Module 12.2 — the delete half. */
export async function deleteAnnouncement(
  announcementId: string,
): Promise<void> {
  const { error } = await supabase
    .from('announcement')
    .delete()
    .eq('announcement_id', announcementId)

  if (error) throw error
}
