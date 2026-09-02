-- ===========================================================================
-- RecoverEase — 04. Communication
-- ===========================================================================
-- ERD entities: chatSession, notification, announcement.
-- Plus one documented addition: chat_message.
-- ===========================================================================

-- Derived from where notifications actually originate in the module list:
-- appointments (6.x), medication reminders (4.2, 4.7), treatment updates
-- (3.x), the chatbot's critical-concern alert (8.2, 8.3), announcements
-- (7.4), and direct doctor-to-patient messages (7.1).
create type public.notification_type as enum (
  'appointment',
  'medication',
  'treatment',
  'chat_critical',
  'announcement',
  'general'
);

-- ---------------------------------------------------------------------------
-- chatSession
-- ---------------------------------------------------------------------------
-- Module 8 is an AI chatbot for post-treatment guidance, not doctor-to-patient
-- messaging. The session carries the metadata the ERD specifies: an external
-- provider reference, start and end timestamps, a critical-concern flag that
-- drives the doctor alert in module 8.2, and a summary.

create table public.chat_session (
  chat_session_id                uuid primary key default gen_random_uuid(),
  pat_id                         uuid not null
                                   references public.patient (pat_id)
                                   on delete cascade,
  -- Conversation identifier at the AI provider, when one is used.
  chat_session_external_ref      text,
  chat_session_started_at        timestamptz not null default now(),
  chat_session_ended_at          timestamptz,
  chat_session_has_critical_flag boolean not null default false,
  chat_session_summary           text,

  constraint chat_session_ends_after_start
    check (
      chat_session_ended_at is null
      or chat_session_ended_at >= chat_session_started_at
    )
);

create index chat_session_pat_idx
  on public.chat_session (pat_id, chat_session_started_at desc);

-- Module 8.3 "Receive AI-Generated Critical Alert": doctors triage flagged
-- sessions, so this partial index covers the only rows that query touches.
create index chat_session_critical_idx
  on public.chat_session (chat_session_started_at desc)
  where chat_session_has_critical_flag;

comment on table public.chat_session is
  'ERD: chatSession. A single conversation between a patient and the AI '
  'guidance chatbot. chat_session_has_critical_flag raises the doctor alert '
  'described in modules 8.2 and 8.3.';

-- ---------------------------------------------------------------------------
-- chat_message  (ADDITION — not in the ERD)
-- ---------------------------------------------------------------------------
-- The ERD models chatSession without any message entity. Modules 8.4 "View
-- Chat History / Past Conversations" and 8.5 "View Patient Chat Transcript"
-- cannot be built without stored messages: a transcript is, definitionally,
-- the messages.
--
-- This is the only entity added to the ERD, and it is added because two
-- named modules require it rather than to enlarge the system. The ERD's
-- chat_session_external_ref is retained for the provider's own conversation
-- id, so the two models coexist.

create table public.chat_message (
  chat_message_id         uuid primary key default gen_random_uuid(),
  chat_session_id         uuid not null
                            references public.chat_session (chat_session_id)
                            on delete cascade,
  chat_message_role       text not null,
  chat_message_content    text not null,
  chat_message_created_at timestamptz not null default now(),

  constraint chat_message_role_allowed
    check (chat_message_role in ('patient', 'assistant')),
  constraint chat_message_content_not_blank
    check (btrim(chat_message_content) <> '')
);

create index chat_message_session_idx
  on public.chat_message (chat_session_id, chat_message_created_at);

comment on table public.chat_message is
  'ADDITION to the ERD. Required by modules 8.4 and 8.5, which cannot be '
  'implemented without a stored transcript.';

-- ---------------------------------------------------------------------------
-- notification
-- ---------------------------------------------------------------------------
-- `chat_session_id` is nullable: it is set only on the critical-concern alert
-- of module 8.2, and null for every other notification type. This is the
-- "triggers" edge drawn between chatSession and notification in the ERD.

create table public.notification (
  notification_id         uuid primary key default gen_random_uuid(),
  user_id                 uuid not null
                            references public.user_account (user_id)
                            on delete cascade,
  chat_session_id         uuid
                            references public.chat_session (chat_session_id)
                            on delete set null,
  notification_type       public.notification_type not null,
  notification_message    text not null,
  notification_is_read    boolean not null default false,
  notification_created_at timestamptz not null default now(),

  constraint notification_message_not_blank
    check (btrim(notification_message) <> '')
);

-- The notification bell reads "my unread notifications, newest first" on
-- every page load; this partial index covers exactly that.
create index notification_unread_idx
  on public.notification (user_id, notification_created_at desc)
  where not notification_is_read;

create index notification_user_idx
  on public.notification (user_id, notification_created_at desc);

-- Chat sessions are deleted whenever their patient is, and this column is
-- ON DELETE SET NULL — so without an index PostgreSQL sequentially scans
-- every notification in the system to resolve one session deletion. Partial,
-- because the column is null on all but the critical-alert notifications.
create index notification_chat_session_idx
  on public.notification (chat_session_id)
  where chat_session_id is not null;

comment on table public.notification is
  'ERD: notification. Addressed to a user account. chat_session_id is set '
  'only for the chatbot critical alert (module 8.2).';

-- ---------------------------------------------------------------------------
-- announcement
-- ---------------------------------------------------------------------------
-- `announcement_published_at` being NULL means the announcement is a draft.
-- Module 12 gives admins create and manage/delete; module 7.4 gives patients
-- read access. Drafts must not be readable, so the nullable timestamp doubles
-- as the visibility switch and is enforced in the RLS policy.

create table public.announcement (
  announcement_id           uuid primary key default gen_random_uuid(),
  admin_id                  uuid not null
                              references public.admin (admin_id)
                              on delete restrict,
  announcement_title        text not null,
  announcement_content      text not null,
  announcement_published_at timestamptz,
  announcement_created_at   timestamptz not null default now(),

  constraint announcement_title_not_blank
    check (btrim(announcement_title) <> ''),
  constraint announcement_content_not_blank
    check (btrim(announcement_content) <> '')
);

create index announcement_published_idx
  on public.announcement (announcement_published_at desc)
  where announcement_published_at is not null;

comment on table public.announcement is
  'ERD: announcement. Posted by an administrator (module 12.1). '
  'announcement_published_at IS NULL marks an unpublished draft, which no '
  'non-admin may read.';
