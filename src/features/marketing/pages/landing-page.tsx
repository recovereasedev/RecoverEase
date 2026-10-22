import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  ChartLine,
  Check,
  ClipboardList,
  Database,
  Info,
  Lock,
  MessageCircle,
  NotebookPen,
  Pill,
  ShieldCheck,
  Stethoscope,
  UserCog,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { BrandWordmark } from '@/components/layout/brand'
import { StatusBadge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { useRevealOnScroll } from '@/features/marketing/use-reveal-on-scroll'
import { patientDoseStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * The public landing page, in the Stitch landing direction.
 *
 * The section order is the design's: what it is (the hero), what it is not
 * (the safety strip), what it does, both sides of one record, how it works,
 * who it is for, the guidance assistant's boundaries, where access is
 * enforced, using it like an app, the questions people ask, and how to get
 * started. The design's visual language was adopted; its copy was checked
 * line by line against what the application actually does, and anything it
 * does not do - calendar sync, offline notifications, e-mailed invitations,
 * encryption claims, "24/7" - is not said here.
 *
 * Two kinds of picture, each labelled as what it is. Real RecoverEase screens
 * captured with a fictional patient (Alice Santos) are marked "Sample data".
 * Examples drawn on this page - the hero's day card and the dose schedule -
 * are marked "Illustrative example": nothing on them came from anyone's
 * record, and no control on them does anything. The portrait is a clinician,
 * not a named member of anyone's staff.
 *
 * Motion is a single quiet arrival per section (`useRevealOnScroll`), never
 * the condition for seeing anything: without script, without
 * IntersectionObserver or under reduced motion every section is simply
 * there, and the heading never waits for an animation.
 */

const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#patients', label: 'For patients' },
  { href: '#clinicians', label: 'For clinicians' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#safety', label: 'Safety' },
]

type Feature = { icon: LucideIcon; title: string; body: string; note: string }

const FEATURES: Feature[] = [
  {
    icon: ClipboardList,
    title: 'Treatment plans',
    body: 'Follow the plan your doctor sets, with dated goals and their notes, in one place.',
    note: 'Print or save as a PDF',
  },
  {
    icon: Pill,
    title: 'Medication reminders',
    body: 'Doses set out by time, worked out from your prescription: doses a day, hours between them and the first dose.',
    note: 'Mark a dose taken, or undo it',
  },
  {
    icon: ChartLine,
    title: 'Recovery progress',
    body: 'Mood and medication over the last 7 or 30 days, with your treatment goals as they stand today.',
    note: 'Mood and medication combined',
  },
  {
    icon: NotebookPen,
    title: 'Daily journal',
    body: 'Rate how you felt from 1 to 5 and write a line about the day. Your entries build the history your doctor reviews.',
    note: 'A streak of the days you log',
  },
  {
    icon: CalendarDays,
    title: 'Appointments',
    body: 'Book a follow-up, confirm you will attend, and request a new time if something comes up.',
    note: 'Appointment reminders',
  },
  {
    icon: MessageCircle,
    title: 'Guidance assistant',
    body: 'Ask general questions about your recovery between appointments. It does not diagnose and cannot change your treatment.',
    note: 'Your doctor is alerted to a critical concern',
  },
]

const STEPS = [
  {
    title: 'Your clinic sets up your account',
    body: 'An administrator registers each doctor, and your doctor registers you. There is no public sign-up, so nobody can create an account against your name.',
  },
  {
    title: 'Your doctor builds your plan',
    body: 'They set your treatment plan, goals, prescriptions and medication schedule. Everything appears in your account as soon as it is saved.',
  },
  {
    title: 'You record how recovery is going',
    body: 'Log each day, mark medication as taken, and keep appointments in one place. Your doctor sees the same record you do.',
  },
]

type Point = { title: string; body: string }

const FOR_PATIENTS: Point[] = [
  {
    title: 'A clear daily routine',
    body: 'Today’s doses set out by time. A dose past its time shows as Overdue, and you can still record it.',
  },
  {
    title: 'A short entry each day',
    body: 'One rating from 1 to 5 and a line about how the day went.',
  },
  {
    title: 'Reminders that matter',
    body: 'Medication and appointment reminders only, not a stream of notifications you learn to ignore.',
  },
  {
    title: 'In your browser',
    body: 'On a phone, tablet or computer, and you can install it so it opens like any other app.',
  },
]

const FOR_CLINICIANS: Point[] = [
  {
    title: 'Context before you walk in',
    body: 'Adherence, the latest entry, the next appointment, plan progress and any flagged conversation, at the top of every record.',
  },
  {
    title: 'Recovery progress',
    body: 'Mood and medication over 7 or 30 days, refreshed every minute while the record is open.',
  },
  {
    title: 'Plans and prescriptions',
    body: 'Set treatment plans and goals, issue prescriptions, and build a dose schedule from three numbers.',
  },
  {
    title: 'Only your patients',
    body: 'You see the patients assigned to you, and Row Level Security in the database enforces it.',
  },
  {
    title: 'Recovery reports',
    body: 'Generate a report on a patient’s recovery, and print it or save it as a PDF.',
  },
]

const GUARDRAILS: { icon: LucideIcon; tone: string; label: string; text: string }[] = [
  {
    icon: Check,
    tone: 'bg-success-50 text-success-700',
    label: 'It does',
    text: 'Offer general guidance about recovery, and help you prepare questions for your doctor.',
  },
  {
    icon: X,
    tone: 'bg-danger-50 text-danger-700',
    label: 'It does not',
    text: 'Diagnose conditions, change a dose, or prescribe anything.',
  },
  {
    icon: AlertTriangle,
    tone: 'bg-warning-50 text-warning-700',
    label: 'If it is serious',
    text: 'When something you raise suggests a critical concern, your doctor is alerted.',
  },
]

const PRIVACY: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Lock,
    title: 'One patient, one clinician',
    body: 'A patient sees only their own record. A doctor sees only the patients assigned to them, not the clinic’s whole list.',
  },
  {
    icon: Database,
    title: 'Rules in the database',
    body: 'Row Level Security policies decide every read and write. Even a direct query returns nothing the account is not entitled to.',
  },
  {
    icon: UserCog,
    title: 'Administrators manage accounts, not records',
    body: 'System administrators run the clinic’s accounts and settings. They cannot read patient records, and the audit trail does not reveal them either.',
  },
]

const QUESTIONS: { question: string; answer: ReactNode }[] = [
  {
    question: 'How do I get an account?',
    answer:
      'Your care team creates it. An administrator registers each doctor, and your doctor registers you, so there is no public sign-up. Sign in with the email address your clinic registered.',
  },
  {
    question: 'I cannot sign in. What should I do?',
    answer: (
      <>
        Use{' '}
        <Link
          to="/forgot-password"
          className="font-semibold text-brand-700 underline underline-offset-4"
        >
          Forgot your password?
        </Link>{' '}
        to get a reset link at your registered email address. If that does not
        work, your doctor or clinic administrator can reset your access.
      </>
    ),
  },
  {
    question: 'Who can see my recovery entries?',
    answer:
      'You and the doctor assigned to you. Administrators run accounts and settings and cannot read patient records.',
  },
  {
    question: 'Is the guidance assistant a doctor?',
    answer:
      'No. It offers general guidance about recovery. It does not diagnose conditions and cannot change your treatment. If something you raise suggests a critical concern, your doctor is alerted. If you feel unwell or something is urgent, contact your doctor or call 911.',
  },
  {
    question: 'What if I miss the time for a dose?',
    answer:
      'A dose that has passed its time shows as Overdue, and you can still mark it as taken. Your doctor sees how your week has gone.',
  },
  {
    question: 'Can I use RecoverEase on my phone?',
    answer:
      'Yes. It works in the browser on a phone, tablet or computer, and you can install it so it opens like any other app.',
  },
]

const SECTION = 'mx-auto max-w-[var(--container-content)] px-5 py-16 sm:px-8 lg:py-24'

/** Staggers the members of a group by `index`, 60ms apart. */
function delay(index: number): CSSProperties {
  return { '--reveal-delay': `${index * 60}ms` } as CSSProperties
}

/** A real screen, captured from the application with sample data. */
function Screen({
  src,
  alt,
  width,
  height,
  className,
}: {
  src: string
  alt: string
  width: number
  height: number
  className?: string
}) {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      className={cn(
        'block h-auto w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface shadow-[var(--shadow-lg)]',
        className,
      )}
    />
  )
}

function SampleNote({ children }: { children?: ReactNode }) {
  return (
    <figcaption className="mt-4 text-sm text-muted">
      <span className="font-semibold text-body">Sample data.</span>{' '}
      {children ?? 'A real RecoverEase screen with a fictional patient.'}
    </figcaption>
  )
}

function SectionIntro({
  id,
  eyebrow,
  title,
  lead,
  centred = false,
}: {
  id: string
  eyebrow?: string
  title: string
  lead?: string
  centred?: boolean
}) {
  return (
    <div className={cn('max-w-2xl', centred && 'mx-auto text-center')} data-reveal>
      {eyebrow ? (
        <p className="text-label-sm uppercase tracking-wider text-accent-700">{eyebrow}</p>
      ) : null}
      <h2
        id={id}
        className="mt-2 text-headline-lg text-heading sm:text-headline-xl"
      >
        {title}
      </h2>
      {lead ? <p className="mt-3 text-body-lg text-muted">{lead}</p> : null}
    </div>
  )
}

export function LandingPage() {
  const pageRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const [isScrolled, setScrolled] = useState(false)
  useRevealOnScroll(pageRef)

  // The header lifts off the page once the page has moved under it. Watched
  // with an observer on the top of the page, not a scroll listener.
  useEffect(() => {
    const top = topRef.current
    if (!top || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      setScrolled(entry ? !entry.isIntersecting : false)
    })
    observer.observe(top)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={pageRef} className="relative min-h-dvh bg-canvas">
      <div ref={topRef} aria-hidden="true" className="absolute inset-x-0 top-0 h-px" />
      <a
        href="#main-content"
        className="sr-only-focusable absolute left-4 top-4 z-50 rounded-[var(--radius-md)] bg-fill-brand-800 px-4 py-2 text-sm font-medium text-white"
      >
        Skip to main content
      </a>

      {/* --- Header --------------------------------------------------------- */}
      <header
        data-scrolled={isScrolled}
        className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-surface transition-shadow duration-[var(--duration-base)] data-[scrolled=true]:shadow-[var(--shadow-md)]"
      >
        <div className="mx-auto flex h-16 max-w-[var(--container-content)] items-center justify-between gap-6 px-5 sm:px-8">
          <Link
            to="/"
            className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] sm:min-h-0"
          >
            <BrandWordmark />
          </Link>

          <nav aria-label="On this page" className="hidden lg:block">
            <ul className="flex items-center gap-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium text-body transition-colors duration-[var(--duration-fast)] hover:bg-neutral-100 hover:text-heading"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex items-center gap-2">
            <a
              href="#how-it-works"
              className={buttonVariants({
                size: 'sm',
                variant: 'outline',
                className: 'max-sm:hidden',
              })}
            >
              See how it works
            </a>
            <Link to="/sign-in" className={buttonVariants({ size: 'sm' })}>
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {/* --- Hero ----------------------------------------------------------
            The heading is never animated: it is on the page from the first
            frame. What follows it rises in once (`landing-rise`). */}
        <section
          aria-labelledby="hero-title"
          className="overflow-hidden border-b border-[var(--color-border)] bg-surface"
        >
          <div className="mx-auto grid max-w-[var(--container-content)] gap-12 px-5 pb-16 pt-12 sm:px-8 lg:grid-cols-12 lg:items-center lg:gap-8 lg:pb-24 lg:pt-20">
            <div className="lg:col-span-6">
              <p className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-accent-50 px-3 py-1.5 text-label-sm uppercase tracking-wider text-accent-800">
                <span aria-hidden="true" className="size-2 rounded-full bg-accent-600" />
                Post-treatment care, made more manageable
              </p>
              <h1
                id="hero-title"
                className="mt-6 max-w-[15ch] text-headline-xl text-brand-800 sm:text-display-sm xl:text-display"
              >
                Recovery support,{' '}
                <span className="text-accent-700">beyond the clinic.</span>
              </h1>

              <div className="landing-rise">
                <p className="mt-6 max-w-xl text-body-lg text-body">
                  RecoverEase keeps your treatment plan, medication schedule,
                  appointments and daily recovery progress in one record, shared
                  with the clinician treating you.
                </p>

                {/* Full width and stacked on a phone; side by side they are
                    wider than the column. */}
                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                  <Link
                    to="/sign-in"
                    className={buttonVariants({ size: 'lg', className: 'max-sm:w-full' })}
                  >
                    Sign in to RecoverEase
                  </Link>
                  <a
                    href="#features"
                    className={buttonVariants({
                      size: 'lg',
                      variant: 'secondary',
                      className: 'max-sm:w-full',
                    })}
                  >
                    Explore features
                  </a>
                </div>

                <p className="mt-8 flex max-w-lg items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface-sunken p-3.5 text-sm text-body">
                  <ShieldCheck
                    className="mt-0.5 size-5 shrink-0 text-accent-700"
                    aria-hidden="true"
                  />
                  <span>
                    <strong className="font-semibold text-heading">
                      Accounts are created by your care team.
                    </strong>{' '}
                    RecoverEase has no public sign-up, so your record is linked
                    only to the clinicians assigned to you.
                  </span>
                </p>
              </div>
            </div>

            <figure className="landing-rise landing-rise-late m-0 lg:col-span-6">
              <HeroVisual />
              <figcaption className="mt-4 text-center text-sm text-muted">
                <span className="font-semibold text-body">Illustrative example.</span>{' '}
                The day card shows a fictional patient, not real patient data.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* --- Safety strip -------------------------------------------------- */}
        <section
          aria-labelledby="safety-strip-title"
          className="border-b border-[var(--color-border)] bg-surface"
        >
          <div
            className="mx-auto flex max-w-5xl flex-col gap-5 px-5 py-10 sm:px-8 md:flex-row md:items-center"
            data-reveal
          >
            <Info className="size-6 shrink-0 text-accent-700" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 id="safety-strip-title" className="text-headline-md text-heading">
                Support for your recovery. Guidance from your care team.
              </h2>
              <p className="mt-1 text-body-md text-body">
                RecoverEase helps you stay organised with your recovery and the
                instructions you already have. It is not a diagnostic system, and
                its guidance assistant does not replace professional medical
                advice. Ask your clinician about any change to your care or your
                medication.
              </p>
            </div>
            <p className="shrink-0 self-start rounded-full border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-body md:self-center">
              Non-diagnostic software
            </p>
          </div>
        </section>

        {/* --- Features ------------------------------------------------------- */}
        <section
          id="features"
          aria-labelledby="features-title"
          className="scroll-mt-20"
        >
          <div className={SECTION}>
            <SectionIntro
              id="features-title"
              eyebrow="For your recovery"
              title="Everything your recovery asks of you, in one place"
              lead="So you and your doctor are working from the same information, not from memory."
              centred
            />
            <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body, note }, index) => (
                <li
                  key={title}
                  data-reveal
                  style={delay(index % 3)}
                  className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-6 transition-[border-color,box-shadow] duration-[var(--duration-base)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]"
                >
                  <Icon className="size-6 text-accent-700" aria-hidden="true" />
                  <h3 className="mt-4 text-lg font-semibold text-heading">{title}</h3>
                  <p className="mt-2 flex-1 text-body-md text-body">{body}</p>
                  <p className="mt-5 border-t border-[var(--color-border)] pt-3 text-sm font-medium text-accent-800">
                    {note}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --- Two people, one record ---------------------------------------- */}
        <section
          aria-labelledby="one-record-title"
          className="border-y border-[var(--color-border)] bg-surface"
        >
          <div className={SECTION}>
            <SectionIntro
              id="one-record-title"
              eyebrow="One shared record"
              title="Two people, one record"
              lead="Recovery breaks down when the patient and the clinician are working from different information. RecoverEase gives each of them the view they need of the same record."
            />

            <div className="mt-12 grid gap-10 md:grid-cols-[0.8fr_1.2fr] md:gap-12">
              <div data-reveal>
                <figure className="m-0 flex items-center justify-center rounded-[var(--radius-xl)] bg-surface-sunken p-6 sm:p-8 md:min-h-[21rem]">
                  <Screen
                    src="/landing/record-patient.webp"
                    width={640}
                    height={500}
                    alt="The patient’s journal on a phone. Today: Walked to the end of the road, felt very good."
                    className="max-w-80"
                  />
                </figure>
                <h3 className="mt-6 text-headline-md text-heading">If you are recovering</h3>
                <p className="mt-2 text-body-md text-body">
                  One place that answers “what am I supposed to be doing
                  today?”: the doses due, the next appointment, the goals you are
                  working towards, and somewhere to record how it is going.
                </p>
              </div>

              <div data-reveal style={delay(1)}>
                <figure className="m-0 flex items-center rounded-[var(--radius-xl)] bg-surface-sunken p-6 sm:p-8 md:min-h-[21rem]">
                  <Screen
                    src="/landing/record-doctor.webp"
                    width={1400}
                    height={472}
                    alt="The same entry in the doctor’s record: today, rated 5 of 5, walked to the end of the road."
                  />
                </figure>
                <h3 className="mt-6 text-headline-md text-heading">If you are treating</h3>
                <p className="mt-2 text-body-md text-body">
                  Each assigned patient’s recovery history and medication
                  adherence as they record it, rather than the last few weeks
                  pieced together from memory at the start of a consultation.
                </p>
              </div>
            </div>
            <p className="mt-8 text-sm text-muted">
              <span className="font-semibold text-body">Sample data.</span> The
              same entry, as the patient wrote it and as her doctor reads it.
            </p>

            <DoseScheduleExample />
          </div>
        </section>

        {/* --- How it works --------------------------------------------------- */}
        <section
          id="how-it-works"
          aria-labelledby="how-it-works-title"
          className="scroll-mt-20"
        >
          <div className={SECTION}>
            <SectionIntro id="how-it-works-title" eyebrow="Getting set up" title="How it works" />
            <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
              {STEPS.map((step, index) => (
                <li key={step.title} className="relative" data-reveal style={delay(index)}>
                  {/* The line joining the steps, on wide screens only. */}
                  {index < STEPS.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-12 right-0 top-[1.125rem] hidden h-px bg-[var(--color-border-strong)] md:block"
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="relative flex size-9 items-center justify-center rounded-full bg-fill-brand-800 text-sm font-semibold text-white"
                  >
                    {index + 1}
                  </span>
                  <h3 className="mt-4 text-lg font-semibold text-heading">
                    <span className="sr-only">Step {index + 1}: </span>
                    {step.title}
                  </h3>
                  <p className="mt-2 text-body-md text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* --- For patients and for clinicians ------------------------------- */}
        <section
          aria-labelledby="audiences-title"
          className="border-y border-[var(--color-border)] bg-surface"
        >
          <div className={SECTION}>
            <SectionIntro
              id="audiences-title"
              eyebrow="Built for both sides of care"
              title="Made for patients and the clinicians treating them"
            />
            <div className="mt-12 grid gap-6 lg:grid-cols-2">
              <AudienceCard
                id="patients"
                icon={UserRound}
                title="For patients"
                lead="Feel more organised through your recovery."
                points={FOR_PATIENTS}
                footnote="Accounts are created by your care team."
                cta="Patient sign in"
              />
              <AudienceCard
                id="clinicians"
                icon={Stethoscope}
                title="For clinicians"
                lead="A clear view of how each patient’s recovery is going."
                points={FOR_CLINICIANS}
                footnote="Doctor accounts are created by the clinic’s administrator."
                cta="Clinician sign in"
                delayIndex={1}
              />
            </div>
          </div>
        </section>

        {/* --- Guidance assistant and safety --------------------------------- */}
        <section
          id="safety"
          aria-labelledby="safety-title"
          className="scroll-mt-20"
        >
          <div className={cn(SECTION, 'grid gap-12 lg:grid-cols-12 lg:items-center')}>
            <div className="lg:col-span-5">
              <SectionIntro
                id="safety-title"
                eyebrow="Guidance with boundaries"
                title="Helpful recovery guidance, with clear boundaries"
                lead="Between appointments, the guidance assistant answers general questions about recovery. It works inside clear limits."
              />
              <ul className="mt-8 space-y-4" data-reveal>
                {GUARDRAILS.map(({ icon: Icon, tone, label, text }) => (
                  <li key={label} className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', tone)}
                    >
                      <Icon className="size-4" />
                    </span>
                    <p className="text-body-md text-body">
                      <span className="font-semibold text-heading">{label}:</span> {text}
                    </p>
                  </li>
                ))}
              </ul>
              <div
                className="mt-8 rounded-[var(--radius-md)] border border-warning-200 bg-warning-50 p-4 text-body-md text-warning-800"
                data-reveal
              >
                <p>
                  <strong className="font-semibold">In an emergency, do not use the chat.</strong>{' '}
                  If you feel unwell or something is urgent, call 911 (the
                  Philippines’ emergency hotline), go to the nearest emergency
                  room, or contact your doctor.
                </p>
              </div>
            </div>
            <figure className="m-0 lg:col-span-7" data-reveal style={delay(1)}>
              <Screen
                src="/landing/feature-chat.webp"
                width={1400}
                height={790}
                alt="The guidance chat, headed by its own notice that it offers general guidance and does not diagnose conditions, with a sample question about remembering an afternoon dose."
              />
              <SampleNote>An illustrative conversation, not a live answer.</SampleNote>
            </figure>
          </div>
        </section>

        {/* --- Privacy ------------------------------------------------------- */}
        <section
          id="privacy"
          aria-labelledby="privacy-title"
          className="scroll-mt-20 border-y border-[var(--color-border)] bg-surface"
        >
          <div className={SECTION}>
            <SectionIntro
              id="privacy-title"
              eyebrow="Access and privacy"
              title="Access is enforced where the data lives"
              lead="Health records deserve more than a hidden menu item. In RecoverEase, every rule about who can see what is enforced by the database itself."
            />
            <ul className="mt-12 grid gap-6 md:grid-cols-3">
              {PRIVACY.map(({ icon: Icon, title, body }, index) => (
                <li
                  key={title}
                  data-reveal
                  style={delay(index)}
                  className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface-sunken p-6"
                >
                  <Icon className="size-5 text-accent-700" aria-hidden="true" />
                  <h3 className="mt-3 font-semibold text-heading">{title}</h3>
                  <p className="mt-1.5 text-body-md text-muted">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --- Install as an app --------------------------------------------- */}
        <section
          id="install"
          aria-labelledby="install-title"
          className="scroll-mt-20"
        >
          <div className={cn(SECTION, 'grid items-center gap-10 md:grid-cols-2 md:gap-16')}>
            <div>
              <SectionIntro
                id="install-title"
                eyebrow="On any device"
                title="Use it like an app, in your browser"
                lead="RecoverEase runs in the browser on a phone, tablet or computer, and you can add it to your home screen or desktop so it opens like any other app."
              />
              <dl className="mt-8 grid gap-4 sm:grid-cols-2" data-reveal>
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface p-4">
                  <dt className="font-semibold text-heading">In Chrome or Edge</dt>
                  <dd className="mt-1 text-body-md text-muted">
                    When RecoverEase offers to install, choose Install. Your
                    browser then asks you to confirm in its own dialog.
                  </dd>
                </div>
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface p-4">
                  <dt className="font-semibold text-heading">On iPhone and iPad</dt>
                  <dd className="mt-1 text-body-md text-muted">
                    In Safari, tap Share, then Add to Home Screen, then Add.
                  </dd>
                </div>
              </dl>
            </div>
            <figure className="m-0" data-reveal style={delay(1)}>
              <Screen
                src="/landing/install.webp"
                width={900}
                height={572}
                alt="RecoverEase’s install offer, with Maybe Later and Install buttons."
                className="mx-auto max-w-md"
              />
              <figcaption className="mt-4 text-center text-sm text-muted">
                RecoverEase’s own offer. The confirmation after it is your
                browser’s.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* --- Questions ----------------------------------------------------- */}
        <section
          id="questions"
          aria-labelledby="questions-title"
          className="scroll-mt-20 border-t border-[var(--color-border)] bg-surface"
        >
          <div className={SECTION}>
            <SectionIntro
              id="questions-title"
              eyebrow="Questions"
              title="Frequently asked questions"
              centred
            />
            {/* Native disclosure: keyboard, screen reader and find-in-page all
                work with no script. */}
            <div className="mx-auto mt-10 max-w-3xl space-y-3">
              {QUESTIONS.map(({ question, answer }) => (
                <details
                  key={question}
                  className="group rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface transition-colors duration-[var(--duration-base)] open:bg-surface-sunken"
                >
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-[var(--radius-lg)] px-5 py-4 text-left text-body-lg font-semibold text-heading [&::-webkit-details-marker]:hidden">
                    {question}
                    <span
                      aria-hidden="true"
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] text-muted transition-transform duration-[var(--duration-base)] group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="max-w-2xl px-5 pb-5 text-body-md text-body">{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* --- Getting started -----------------------------------------------
            The brand gradient's one appearance on this page: the brand
            panel, which is where the design system allows it. */}
        <section aria-labelledby="getting-started-title" className="brand-gradient">
          <div className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-8 lg:py-20">
            <h2
              id="getting-started-title"
              className="text-headline-lg text-white sm:text-headline-xl"
            >
              Getting started
            </h2>
            <p className="mt-3 text-body-lg text-white">
              If your clinic already uses RecoverEase, your care team will have
              registered you and given you your sign-in details. Use the email
              address they registered.
            </p>
            <p className="mt-2 text-body-md text-white">
              If you cannot sign in, contact your doctor or clinic administrator.
              They can reset your access.
            </p>

            <Link
              to="/sign-in"
              className={buttonVariants({
                size: 'lg',
                variant: 'outline',
                className: 'mt-8 border-white max-sm:w-full',
              })}
            >
              Sign in to RecoverEase
            </Link>
          </div>
        </section>
      </main>

      {/* --- Footer --------------------------------------------------------- */}
      <footer className="border-t border-[var(--color-border)] bg-canvas">
        <div className="mx-auto max-w-[var(--container-content)] px-5 py-10 sm:px-8">
          <div className="flex flex-col gap-6 border-b border-[var(--color-border)] pb-8 md:flex-row md:items-center md:justify-between">
            <div>
              <BrandWordmark />
              <p className="mt-2 text-sm text-muted">Recovery support, beyond the clinic</p>
            </div>
            <nav aria-label="Footer">
              <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      className="inline-flex min-h-11 items-center text-body hover:text-heading sm:min-h-0"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
                <li>
                  <Link
                    to="/sign-in"
                    className="inline-flex min-h-11 items-center text-brand-700 underline-offset-4 hover:underline sm:min-h-0"
                  >
                    Sign in
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
          <p className="mt-6 max-w-3xl text-sm text-muted">
            <strong className="font-semibold text-body">Medical notice:</strong>{' '}
            RecoverEase is a recovery management and coordination tool. It does
            not provide medical diagnoses, treatment decisions or emergency
            responses. Follow the care plan your clinician gave you, and for
            urgent symptoms call 911 or go to the nearest emergency room.
          </p>
        </div>
      </footer>
    </div>
  )
}

/**
 * The hero's picture: a clinician, and in front of her an illustrative day
 * card - the shape of a patient's day in RecoverEase, drawn on the page with
 * a fictional patient. The card is labelled as an example on itself and
 * below, carries no percentages, and none of it is a working control.
 */
function HeroVisual() {
  return (
    <div className="relative mx-auto max-w-xl lg:mr-0">
      {/* A flat panel the portrait stands in, so it sits on something in
          either theme. Decorative only. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-6 bottom-0 top-16 rounded-[var(--radius-xl)] bg-surface-raised sm:inset-x-12"
      />
      <img
        src="/landing/hero-clinician.webp"
        width={736}
        height={1024}
        alt="A clinician holding a tablet."
        loading="eager"
        decoding="async"
        fetchPriority="high"
        className="relative mx-auto block h-auto w-full max-w-sm lg:max-w-md"
      />

      <div className="relative -mt-24 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-4 shadow-[var(--shadow-lg)] sm:mx-8 lg:absolute lg:-left-6 lg:bottom-10 lg:mx-0 lg:mt-0 lg:w-[22.5rem]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-50 text-sm font-semibold text-accent-800"
            >
              AS
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-heading">Alice Santos</p>
              <p className="text-sm text-muted">Post-operative knee recovery</p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-body">
            Example
          </span>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2">
            <dt className="text-xs text-muted">Doses today</dt>
            <dd className="font-semibold text-heading">2 of 3 taken</dd>
          </div>
          <div className="rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2">
            <dt className="text-xs text-muted">Next visit</dt>
            <dd className="font-semibold text-heading">Tuesday</dd>
          </div>
        </dl>

        <p className="mt-4 text-label-sm uppercase tracking-wider text-muted">Today’s doses</p>
        <ul className="mt-2 space-y-2 text-sm">
          {[
            { time: '08:00', status: patientDoseStatus.taken },
            { time: '12:00', status: patientDoseStatus.taken },
            { time: '16:00', status: patientDoseStatus.due },
          ].map(({ time, status }) => (
            <li
              key={time}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
            >
              <span className="min-w-0">
                <span className="font-semibold text-heading" data-numeric>
                  {time}
                </span>{' '}
                <span className="whitespace-nowrap text-body">Paracetamol 500 mg</span>
              </span>
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * "Medication schedules from three numbers", drawn rather than captured so
 * the worked-out times can arrive one after another. The numbers are an
 * example; nothing here is a form.
 */
function DoseScheduleExample() {
  const times = ['08:00', '12:00', '16:00']

  return (
    <div className="mt-14 grid gap-8 rounded-[var(--radius-xl)] bg-surface-sunken p-6 sm:p-8 lg:grid-cols-12 lg:items-center">
      <div className="lg:col-span-5" data-reveal>
        <p className="text-label-sm uppercase tracking-wider text-accent-700">Prescribing</p>
        <h3 className="mt-2 text-headline-md text-heading">
          Medication schedules from three numbers
        </h3>
        <p className="mt-2 text-body-md text-body">
          The doctor enters the doses a day, the hours between them and the
          first dose. RecoverEase works out the times, and the patient’s
          checklist and reminders follow them.
        </p>
      </div>

      <figure
        className="m-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-5 lg:col-span-7"
        data-reveal
        style={delay(1)}
      >
        <dl className="grid grid-cols-3 gap-3">
          {[
            ['Doses a day', '3'],
            ['Hours between', '4'],
            ['First dose', '08:00'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-muted">{label}</dt>
              <dd className="mt-1 rounded-[var(--radius-sm)] bg-surface-sunken px-2.5 py-1.5 font-semibold text-heading" data-numeric>
                {value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <p className="text-sm text-muted">Dose times worked out</p>
          <ol className="relative mt-3 flex items-center justify-between gap-2" aria-label="Dose times worked out">
            {/* The line the times sit on, drawn across once. */}
            <span
              aria-hidden="true"
              data-reveal="line"
              className="absolute inset-x-4 top-1/2 h-px bg-[var(--color-border-strong)]"
            />
            {times.map((time, index) => (
              <li
                key={time}
                data-reveal
                style={delay(index + 2)}
                className="relative rounded-[var(--radius-sm)] bg-accent-50 px-3 py-1 font-semibold text-accent-800"
                data-numeric
              >
                {time}
              </li>
            ))}
          </ol>
        </div>
        <figcaption className="mt-4 text-sm text-muted">
          <span className="font-semibold text-body">Illustrative example.</span>{' '}
          3 doses, 4 hours apart, from 08:00.
        </figcaption>
      </figure>
    </div>
  )
}

function AudienceCard({
  id,
  icon: Icon,
  title,
  lead,
  points,
  footnote,
  cta,
  delayIndex = 0,
}: {
  id: string
  icon: LucideIcon
  title: string
  lead: string
  points: Point[]
  footnote: string
  cta: string
  delayIndex?: number
}) {
  return (
    <article
      id={id}
      aria-labelledby={`${id}-title`}
      data-reveal
      style={delay(delayIndex)}
      className="flex scroll-mt-20 flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface-sunken p-6 sm:p-8"
    >
      <div className="flex items-center gap-3">
        <Icon className="size-6 shrink-0 text-accent-700" aria-hidden="true" />
        <div>
          <h3 id={`${id}-title`} className="text-headline-md text-heading">
            {title}
          </h3>
          <p className="text-sm text-muted">{lead}</p>
        </div>
      </div>
      <ul className="mt-6 flex-1 space-y-4">
        {points.map((point) => (
          <li key={point.title} className="flex items-start gap-3">
            <Check className="mt-1 size-4 shrink-0 text-accent-700" aria-hidden="true" />
            <p className="text-body-md text-body">
              <span className="font-semibold text-heading">{point.title}.</span> {point.body}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-5">
        <p className="text-sm text-muted">{footnote}</p>
        <Link
          to="/sign-in"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand-700 underline-offset-4 hover:underline"
        >
          {cta}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </article>
  )
}
