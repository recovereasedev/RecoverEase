import {
  Activity,
  Bell,
  CalendarDays,
  ClipboardList,
  Database,
  FileBarChart,
  Lock,
  MessageCircle,
  Pill,
  ShieldCheck,
  Stethoscope,
  UserCog,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { BrandWordmark } from '@/components/layout/brand'
import { buttonVariants } from '@/components/ui/button'
import { ProductPreview } from '@/features/marketing/components/product-preview'

type Feature = { icon: LucideIcon; title: string; body: string }

const PATIENT_FEATURES: Feature[] = [
  {
    icon: Activity,
    title: 'Daily recovery log',
    body: 'Record how each day went and how you felt. Your entries build the history your clinician reviews before an appointment.',
  },
  {
    icon: Pill,
    title: 'Medication schedule',
    body: 'See what is due and when, mark each dose as taken, and set the time of day you would like to be reminded.',
  },
  {
    icon: ClipboardList,
    title: 'Treatment plan and goals',
    body: 'Follow the plan your doctor set, with dated goals so progress is something you can actually see.',
  },
  {
    icon: CalendarDays,
    title: 'Appointments',
    body: 'Book a follow-up, confirm you will attend, and request a new time if something comes up.',
  },
  {
    icon: MessageCircle,
    title: 'Guidance chat',
    body: 'Ask questions about your recovery between visits. If something you raise looks urgent, your doctor is alerted.',
  },
  {
    icon: Bell,
    title: 'Reminders that matter',
    body: 'Medication and appointment reminders only — not a stream of notifications you learn to ignore.',
  },
]

const CLINICIAN_FEATURES: Feature[] = [
  {
    icon: Stethoscope,
    title: 'Your patients, in context',
    body: 'Recovery history, medication adherence and notes for each patient assigned to you, in one place.',
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

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string
  title: string
  description?: string
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      {eyebrow ? (
        <p className="text-sm font-semibold uppercase tracking-wide text-accent-700">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-heading sm:text-3xl">
        {title}
      </h2>
      {description ? (
        <p className="mt-3 text-muted">{description}</p>
      ) : null}
    </div>
  )
}

function FeatureCard({ icon: Icon, title, body }: Feature) {
  return (
    <li className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-5">
      <span className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-brand-50">
        <Icon className="size-5 text-brand-700" aria-hidden="true" />
      </span>
      <h3 className="mt-4 font-semibold text-heading">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
    </li>
  )
}

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-canvas">
      <a
        href="#main-content"
        className="sr-only-focusable absolute left-4 top-4 z-50 rounded-[var(--radius-md)] bg-brand-600 px-4 py-2 text-sm font-medium text-white"
      >
        Skip to main content
      </a>

      {/* --- Header ------------------------------------------------------- */}
      <header className="border-b border-[var(--color-border)] bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link to="/" className="rounded-[var(--radius-sm)]">
            <BrandWordmark />
          </Link>
          <Link to="/sign-in" className={buttonVariants({ size: 'sm' })}>
            Sign in
          </Link>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {/* --- Hero ------------------------------------------------------- */}
        <section className="border-b border-[var(--color-border)] bg-surface">
          <div className="mx-auto grid max-w-6xl gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:py-24">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-accent-200 bg-accent-50 px-3 py-1 text-sm font-medium text-accent-800">
                <ShieldCheck className="size-4" aria-hidden="true" />
                For clinics and their patients
              </p>

              <h1 className="mt-5 text-4xl font-semibold tracking-tight text-heading sm:text-5xl sm:leading-[1.1]">
                Recovery, followed properly —{' '}
                <span className="brand-gradient-text">start to finish</span>
              </h1>

              <p className="mt-5 max-w-xl text-lg leading-relaxed text-body">
                RecoverEase keeps a patient’s treatment plan, medication
                schedule, appointments and daily progress in one shared record
                — so the person recovering and the clinician treating them are
                looking at the same thing.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/sign-in" className={buttonVariants({ size: 'lg' })}>
                  Sign in to your account
                </Link>
                <a
                  href="#how-it-works"
                  className={buttonVariants({
                    size: 'lg',
                    variant: 'secondary',
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

            <div className="lg:pl-4">
              <ProductPreview />
            </div>
          </div>
        </section>

        {/* --- Who it helps ----------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
          <SectionHeading
            eyebrow="Who it is for"
            title="Two people, one record"
            description="Recovery breaks down when the patient and the clinician are working from different information. RecoverEase gives each of them the view they need of the same underlying record."
          />

          <div className="mt-10 grid gap-5 md:grid-cols-2">
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-6">
              <h3 className="text-lg font-semibold text-heading">
                If you are recovering
              </h3>
              <p className="mt-2 text-body">
                You get one place that answers “what am I supposed to be doing
                today?” — the doses due, the next appointment, the goals you
                are working towards, and somewhere to record how it is
                actually going.
              </p>
            </div>

            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-6">
              <h3 className="text-lg font-semibold text-heading">
                If you are treating
              </h3>
              <p className="mt-2 text-body">
                You see each assigned patient’s recovery history and medication
                adherence as they record it, rather than reconstructing the
                last few weeks from memory at the start of a consultation.
              </p>
            </div>
          </div>
        </section>

        {/* --- How it works ------------------------------------------------ */}
        <section
          id="how-it-works"
          className="scroll-mt-8 border-y border-[var(--color-border)] bg-surface"
        >
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
            <SectionHeading eyebrow="How it works" title="Three steps" />

            <ol className="mt-10 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="relative">
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white"
                  >
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-semibold text-heading">
                    <span className="sr-only">Step {index + 1}: </span>
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* --- Patient features -------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
          <SectionHeading
            eyebrow="For patients"
            title="Everything your recovery asks of you, in one place"
          />
          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PATIENT_FEATURES.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </ul>
        </section>

        {/* --- Clinician features ------------------------------------------ */}
        <section className="border-y border-[var(--color-border)] bg-surface">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
            <SectionHeading
              eyebrow="For clinicians"
              title="The context you need before you walk in"
            />
            <ul className="mt-10 grid gap-5 sm:grid-cols-2">
              {CLINICIAN_FEATURES.map((feature) => (
                <FeatureCard key={feature.title} {...feature} />
              ))}
            </ul>
          </div>
        </section>

        {/* --- Security ----------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
          <SectionHeading
            eyebrow="Privacy"
            title="Access is enforced where the data lives"
            description="Health records deserve more than a hidden menu item. In RecoverEase, every rule about who can see what is enforced by the database itself."
          />

          <ul className="mt-10 grid gap-5 md:grid-cols-3">
            <li className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-6">
              <Lock className="size-5 text-accent-700" aria-hidden="true" />
              <h3 className="mt-4 font-semibold text-heading">
                One patient, one clinician
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                A patient sees only their own record. A doctor sees only the
                patients assigned to them — not the clinic’s whole list.
              </p>
            </li>

            <li className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-6">
              <Database className="size-5 text-accent-700" aria-hidden="true" />
              <h3 className="mt-4 font-semibold text-heading">
                Rules in the database
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                Row-level security policies decide every read and write. Even
                a direct query returns nothing the account is not entitled to.
              </p>
            </li>

            <li className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-6">
              <UserCog className="size-5 text-accent-700" aria-hidden="true" />
              <h3 className="mt-4 font-semibold text-heading">
                Administrators manage accounts, not records
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                System administrators run the clinic’s accounts and settings.
                They cannot read patient records, and the audit trail does not
                reveal them either.
              </p>
            </li>
          </ul>
        </section>

        {/* --- Getting started ---------------------------------------------- */}
        <section className="border-t border-[var(--color-border)] bg-surface">
          <div className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-8 lg:py-20">
            <h2 className="text-2xl font-semibold tracking-tight text-heading sm:text-3xl">
              Getting started
            </h2>
            <p className="mt-3 text-muted">
              If your clinic already uses RecoverEase, your care team will have
              registered you and sent your sign-in details. Use the email
              address they registered.
            </p>
            <p className="mt-2 text-muted">
              If you cannot sign in, contact your doctor or clinic
              administrator — they can reset your access.
            </p>

            <Link
              to="/sign-in"
              className={buttonVariants({ size: 'lg', className: 'mt-8' })}
            >
              Sign in to RecoverEase
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--color-border)] bg-canvas">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
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
