import {
  Bell,
  CalendarDays,
  ClipboardList,
  Database,
  FileBarChart,
  Lock,
  Stethoscope,
  UserCog,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { BrandWordmark } from '@/components/layout/brand'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The public landing page (RecoverEase 2.0).
 *
 * It shows the product instead of describing it. Every picture on this page is
 * a real RecoverEase screen, captured from the application with a fictional
 * patient (Alice Santos) and doctor, and labelled as sample data - not a
 * mock-up, and not stock imagery. The thirteen interchangeable icon cards the
 * page used to be built from are gone: each claim now sits next to the screen
 * that proves it.
 *
 * The story runs in the order a visitor asks: what is it (the hero, both
 * sides of one record), who is it for (patient and clinician, the same entry
 * seen by each), how does it work (three steps), what does it do (real
 * screens), is my data safe (where access is enforced), can I use it on my
 * phone (install), and the questions people actually ask. Nothing here is a
 * number the product does not hold, and nothing claims a clinical outcome.
 */

const NAV = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#patients', label: 'For patients' },
  { href: '#clinicians', label: 'For clinicians' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#questions', label: 'Questions' },
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

type Point = { icon: LucideIcon; title: string; body: string }

const ALSO_FOR_PATIENTS: Point[] = [
  {
    icon: ClipboardList,
    title: 'Treatment plan and goals',
    body: 'Follow the plan your doctor set, with dated goals, and print it or save it as a PDF.',
  },
  {
    icon: CalendarDays,
    title: 'Appointments',
    body: 'Book a follow-up, confirm you will attend, and request a new time if something comes up.',
  },
  {
    icon: Bell,
    title: 'Reminders that matter',
    body: 'Medication and appointment reminders only, not a stream of notifications you learn to ignore.',
  },
]

const FOR_CLINICIANS: Point[] = [
  {
    icon: Stethoscope,
    title: 'Your patients, in context',
    body: 'Adherence, the latest entry, the next appointment, plan progress and any flagged conversation, at the top of every record.',
  },
  {
    icon: ClipboardList,
    title: 'Plans and prescriptions',
    body: 'Set treatment plans, define goals, issue prescriptions and configure medication schedules.',
  },
  {
    icon: CalendarDays,
    title: 'Scheduling control',
    body: 'Review reschedule requests and approve or decline them. Approving moves the appointment for you.',
  },
  {
    icon: FileBarChart,
    title: 'Recovery reports',
    body: 'Generate a report on a patient’s recovery when you need something to share or file.',
  },
]

const PRIVACY: Point[] = [
  {
    icon: Lock,
    title: 'One patient, one clinician',
    body: 'A patient sees only their own record. A doctor sees only the patients assigned to them, not the clinic’s whole list.',
  },
  {
    icon: Database,
    title: 'Rules in the database',
    body: 'Row-level security policies decide every read and write. Even a direct query returns nothing the account is not entitled to.',
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
    question: 'Is the guidance chat a doctor?',
    answer:
      'No. It offers general guidance about recovery. It does not diagnose conditions and cannot change your treatment. If something you raise suggests a critical concern, your doctor is alerted. If you feel unwell or something is urgent, contact your doctor or emergency services directly.',
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

/** A real screen, captured from the application with sample data. */
function Screen({
  src,
  alt,
  width,
  height,
  className,
  priority = false,
}: {
  src: string
  alt: string
  width: number
  height: number
  className?: string
  priority?: boolean
}) {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' as const } : {})}
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
  title,
  lead,
}: {
  id?: string
  title: string
  lead?: string
}) {
  return (
    <div className="max-w-2xl">
      <h2
        id={id}
        className="text-headline-lg text-heading sm:text-headline-xl"
      >
        {title}
      </h2>
      {lead ? (
        <p className="mt-3 text-body-lg text-muted">{lead}</p>
      ) : null}
    </div>
  )
}

/** A claim beside the screen that shows it. */
function FeatureRow({
  title,
  body,
  image,
  reverse = false,
}: {
  title: string
  body: string
  image: ReactNode
  reverse?: boolean
}) {
  return (
    <div className="grid items-center gap-6 md:grid-cols-2 md:gap-12">
      <div className={cn(reverse && 'md:order-2')}>
        <h3 className="text-headline-md text-heading">{title}</h3>
        <p className="mt-2 text-body-md text-body">{body}</p>
      </div>
      <figure className={cn('m-0', reverse && 'md:order-1')}>{image}</figure>
    </div>
  )
}

function PointList({
  points,
  columns,
}: {
  points: Point[]
  columns: 'md:grid-cols-2' | 'md:grid-cols-3'
}) {
  return (
    <ul className={cn('grid gap-x-10 gap-y-8', columns)}>
      {points.map(({ icon: Icon, title, body }) => (
        <li key={title} className="border-t border-[var(--color-border)] pt-5">
          <Icon className="size-5 text-accent-700" aria-hidden="true" />
          <h3 className="mt-3 font-semibold text-heading">{title}</h3>
          <p className="mt-1.5 text-body-md text-muted">{body}</p>
        </li>
      ))}
    </ul>
  )
}

const SECTION = 'mx-auto max-w-[var(--container-content)] px-5 py-16 sm:px-8 lg:py-24'

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-canvas">
      <a
        href="#main-content"
        className="sr-only-focusable absolute left-4 top-4 z-50 rounded-[var(--radius-md)] bg-brand-800 px-4 py-2 text-sm font-medium text-white"
      >
        Skip to main content
      </a>

      {/* --- Header ------------------------------------------------------- */}
      <header className="border-b border-[var(--color-border)] bg-surface">
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

          <Link to="/sign-in" className={buttonVariants({ size: 'sm' })}>
            Sign in
          </Link>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {/* --- Hero -------------------------------------------------------
            Both sides of one record, from the application itself: the
            doctor's view of a patient, and the same patient's day on her
            phone. */}
        <section className="overflow-hidden border-b border-[var(--color-border)] bg-surface">
          <div className="mx-auto grid max-w-[var(--container-content)] gap-12 px-5 pb-20 pt-14 sm:px-8 lg:grid-cols-[1fr_1.15fr] lg:items-center lg:gap-16 lg:pb-24 lg:pt-20">
            <div className="landing-rise">
              <h1 className="max-w-[16ch] text-headline-xl text-brand-800 sm:text-display-sm xl:text-display">
                Recovery, followed properly — start to finish
              </h1>
              <p className="mt-5 max-w-xl text-body-lg text-body">
                RecoverEase keeps a patient’s treatment plan, medication
                schedule, appointments and daily progress in one shared record,
                so the person recovering and the clinician treating them are
                looking at the same thing.
              </p>

              {/* Full width and stacked on a phone. Side by side these two
                  are about 370px of button in a 335px column, so they wrapped
                  into two left-aligned rows of different widths. */}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link
                  to="/sign-in"
                  className={buttonVariants({
                    size: 'lg',
                    className: 'max-sm:w-full',
                  })}
                >
                  Sign in to your account
                </Link>
                <a
                  href="#how-it-works"
                  className={buttonVariants({
                    size: 'lg',
                    variant: 'secondary',
                    className: 'max-sm:w-full',
                  })}
                >
                  See how it works
                </a>
              </div>

              <p className="mt-4 text-sm text-muted">
                Accounts are created by your care team. RecoverEase has no
                public sign-up.
              </p>
            </div>

            <figure className="landing-rise landing-rise-late m-0">
              {/* The phone sits over the doctor screen's navigation column,
                  so it hides nothing of the record itself. */}
              <div className="relative pb-16 pl-8 sm:pb-20 sm:pl-12">
                <Screen
                  src="/landing/hero-doctor.webp"
                  width={1600}
                  height={1000}
                  priority
                  alt="A doctor’s view of a patient record in RecoverEase. At the top: adherence over the last 7 days, the last recovery entry, the next appointment, treatment-plan progress, and one flagged conversation. Below: the patient’s recovery trend."
                />
                <Screen
                  src="/landing/hero-patient.webp"
                  width={520}
                  height={1040}
                  priority
                  alt="The same patient’s dashboard on a phone: today’s three doses, two taken and one overdue with a Mark taken button."
                  className="absolute bottom-0 left-0 w-[24%] min-w-24 rounded-[1.25rem] border-4 border-surface shadow-[0_24px_48px_-12px_rgb(17_28_45/0.35)]"
                />
              </div>
              <SampleNote>
                Real RecoverEase screens with a fictional patient: her
                doctor’s view, and her own day on a phone.
              </SampleNote>
            </figure>
          </div>
        </section>

        {/* --- Two people, one record ------------------------------------- */}
        <section aria-labelledby="one-record" className={SECTION}>
          <SectionIntro
            id="one-record"
            title="Two people, one record"
            lead="Recovery breaks down when the patient and the clinician are working from different information. RecoverEase gives each of them the view they need of the same underlying record."
          />

          <div className="mt-12 grid gap-10 md:grid-cols-[0.8fr_1.2fr] md:gap-12">
            <div>
              <figure className="m-0 flex items-center justify-center rounded-[var(--radius-xl)] bg-surface-sunken p-6 sm:p-8 md:min-h-[21rem]">
                <Screen
                  src="/landing/record-patient.webp"
                  width={640}
                  height={500}
                  alt="The patient’s journal on a phone. Today: Walked to the end of the road, felt very good."
                  className="max-w-80"
                />
              </figure>
              <h3 className="mt-6 text-headline-md text-heading">
                If you are recovering
              </h3>
              <p className="mt-2 text-body-md text-body">
                You get one place that answers “what am I supposed to be doing
                today?”: the doses due, the next appointment, the goals you are
                working towards, and somewhere to record how it is actually
                going.
              </p>
            </div>

            <div>
              <figure className="m-0 flex items-center rounded-[var(--radius-xl)] bg-surface-sunken p-6 sm:p-8 md:min-h-[21rem]">
                <Screen
                  src="/landing/record-doctor.webp"
                  width={1400}
                  height={472}
                  alt="The same entry in the doctor’s record: today, rated 5 of 5, walked to the end of the road."
                />
              </figure>
              <h3 className="mt-6 text-headline-md text-heading">
                If you are treating
              </h3>
              <p className="mt-2 text-body-md text-body">
                You see each assigned patient’s recovery history and medication
                adherence as they record it, rather than reconstructing the
                last few weeks from memory at the start of a consultation.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm text-muted">
            <span className="font-semibold text-body">Sample data.</span> The
            same entry, as the patient wrote it and as her doctor reads it.
          </p>
        </section>

        {/* --- How it works ------------------------------------------------ */}
        <section
          id="how-it-works"
          aria-labelledby="how-it-works-title"
          className="scroll-mt-8 border-y border-[var(--color-border)] bg-surface"
        >
          <div className={SECTION}>
            <SectionIntro id="how-it-works-title" title="How it works" />
            <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
              {STEPS.map((step, index) => (
                <li key={step.title} className="relative">
                  {/* The line joining the steps, on wide screens only. */}
                  {index < STEPS.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-12 right-0 top-[1.125rem] hidden h-px bg-[var(--color-border-strong)] md:block"
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="relative flex size-9 items-center justify-center rounded-full bg-brand-800 text-sm font-semibold text-white"
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

        {/* --- For patients ------------------------------------------------ */}
        <section
          id="patients"
          aria-labelledby="patients-title"
          className={cn(SECTION, 'scroll-mt-8')}
        >
          <SectionIntro
            id="patients-title"
            title="Everything your recovery asks of you, in one place"
          />

          <div className="mt-14 space-y-16 lg:space-y-24">
            <FeatureRow
              title="Know what is due, and mark it taken"
              body="Today’s doses, set out by time. Mark each one as taken when you have taken it, and choose the time of day you would like to be reminded. A dose that has passed its time shows as Overdue, and can still be recorded."
              image={
                <>
                  <Screen
                    src="/landing/feature-medication.webp"
                    width={1224}
                    height={616}
                    alt="Due today: 08:00 and 12:00 taken, 16:00 overdue with a Mark taken button."
                  />
                  <SampleNote />
                </>
              }
            />
            <FeatureRow
              reverse
              title="A short entry each day"
              body="Rate how you felt from 1 to 5 and write a line about the day. Your entries build the history your doctor reviews before an appointment, and a streak shows how many days in a row you have logged."
              image={
                <>
                  <Screen
                    src="/landing/feature-recovery.webp"
                    width={1216}
                    height={1006}
                    alt="Today’s recovery entry: a rating from 1, very poor, to 5, very good, with 5 selected, and the note Walked to the end of the road."
                  />
                  <SampleNote />
                </>
              }
            />
            <FeatureRow
              title="Guidance between visits"
              body="Ask questions about your recovery between appointments. The assistant offers general guidance only: it does not diagnose conditions and cannot change your treatment. If something you raise suggests a critical concern, your doctor is alerted."
              image={
                <>
                  <Screen
                    src="/landing/feature-chat.webp"
                    width={1400}
                    height={790}
                    alt="The guidance chat, headed by its own notice that it offers general guidance and does not diagnose conditions, with a sample question about remembering an afternoon dose."
                  />
                  <SampleNote>
                    An illustrative conversation, not a live answer.
                  </SampleNote>
                </>
              }
            />
          </div>

          <div className="mt-20">
            <h3 className="text-headline-md text-heading">
              Also in your account
            </h3>
            <div className="mt-6">
              <PointList points={ALSO_FOR_PATIENTS} columns="md:grid-cols-3" />
            </div>
          </div>
        </section>

        {/* --- For clinicians ---------------------------------------------- */}
        <section
          id="clinicians"
          aria-labelledby="clinicians-title"
          className="scroll-mt-8 border-y border-[var(--color-border)] bg-surface"
        >
          <div className={SECTION}>
            <SectionIntro
              id="clinicians-title"
              title="The context you need before you walk in"
            />

            <div className="mt-14">
              <FeatureRow
                title="Medication schedules from three numbers"
                body="Enter the doses a day, the hours between them and the first dose. RecoverEase works out the times, and the patient’s checklist and reminders follow them."
                image={
                  <>
                    <Screen
                      src="/landing/feature-prescribing.webp"
                      width={1400}
                      height={348}
                      alt="The prescription form: 3 doses a day, 4 hours between doses, first dose at 08:00, and the dose times worked out as 08:00, 12:00 and 16:00."
                    />
                    <SampleNote />
                  </>
                }
              />
            </div>

            <div className="mt-16">
              <PointList points={FOR_CLINICIANS} columns="md:grid-cols-2" />
            </div>
          </div>
        </section>

        {/* --- Privacy ------------------------------------------------------ */}
        <section
          id="privacy"
          aria-labelledby="privacy-title"
          className={cn(SECTION, 'scroll-mt-8')}
        >
          <SectionIntro
            id="privacy-title"
            title="Access is enforced where the data lives"
            lead="Health records deserve more than a hidden menu item. In RecoverEase, every rule about who can see what is enforced by the database itself."
          />
          <div className="mt-12">
            <PointList points={PRIVACY} columns="md:grid-cols-3" />
          </div>
        </section>

        {/* --- Install as an app ------------------------------------------- */}
        <section
          id="install"
          aria-labelledby="install-title"
          className="scroll-mt-8 border-y border-[var(--color-border)] bg-surface"
        >
          <div
            className={cn(
              SECTION,
              'grid items-center gap-10 md:grid-cols-2 md:gap-16',
            )}
          >
            <div>
              <SectionIntro
                id="install-title"
                title="Use it like an app"
                lead="RecoverEase runs in the browser on a phone, tablet or computer, and you can add it to your home screen or desktop so it opens like any other app."
              />
              <dl className="mt-8 space-y-5">
                <div>
                  <dt className="font-semibold text-heading">
                    In Chrome or Edge
                  </dt>
                  <dd className="mt-1 text-body-md text-muted">
                    When RecoverEase offers to install, choose Install. Your
                    browser then asks you to confirm in its own dialog.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-heading">
                    On iPhone and iPad
                  </dt>
                  <dd className="mt-1 text-body-md text-muted">
                    In Safari, tap Share, then Add to Home Screen, then Add.
                  </dd>
                </div>
              </dl>
            </div>
            <figure className="m-0">
              <Screen
                src="/landing/install.webp"
                width={800}
                height={406}
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

        {/* --- Questions ---------------------------------------------------- */}
        <section
          id="questions"
          aria-labelledby="questions-title"
          className={cn(SECTION, 'scroll-mt-8')}
        >
          <SectionIntro id="questions-title" title="Questions" />
          {/* Native disclosure: keyboard, screen reader and find-in-page all
              work with no script. */}
          <div className="mt-10 max-w-3xl divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {QUESTIONS.map(({ question, answer }) => (
              <details key={question} className="group">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left text-body-lg font-semibold text-heading [&::-webkit-details-marker]:hidden">
                  {question}
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] text-muted transition-transform duration-[var(--duration-base)] group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl pb-5 text-body-md text-body">
                  {answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* --- Getting started ----------------------------------------------
            The brand gradient's one appearance on this page: the brand
            panel, which is where the design system allows it. */}
        <section className="brand-gradient">
          <div className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-8 lg:py-20">
            <h2 className="text-headline-lg text-white sm:text-headline-xl">
              Getting started
            </h2>
            <p className="mt-3 text-body-lg text-white">
              If your clinic already uses RecoverEase, your care team will have
              registered you and sent your sign-in details. Use the email
              address they registered.
            </p>
            <p className="mt-2 text-body-md text-white">
              If you cannot sign in, contact your doctor or clinic
              administrator. They can reset your access.
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

      <footer className="bg-canvas">
        <div className="mx-auto flex max-w-[var(--container-content)] flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <BrandWordmark />
          <p className="text-sm text-muted">
            RecoverEase is a recovery management tool. It does not provide
            diagnosis or medical advice.
          </p>
        </div>
      </footer>
    </div>
  )
}
