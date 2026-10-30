import {
  prescriberName,
  prescriberOf,
  type PrescriberDetails,
} from '@/features/medications/prescriber'
import type { Patient } from '@/features/patients/api'
import { reportDate } from '@/features/reports/report-format'
import {
  byTargetDate,
  summariseGoals,
  type PlanWithGoals,
  type TreatmentGoalStatus,
} from '@/features/treatment-plans/api'
import {
  documentFileName,
  PDF_TYPE,
  type DownloadableFile,
} from '@/lib/documents/download'
import { wrapText } from '@/lib/documents/pdf'
import {
  BODY,
  BORDER,
  type Colour,
  createSheetDocument,
  drawContinuation,
  drawFooters,
  drawLetterhead,
  drawPatientBlock,
  drawTable,
  FIELD,
  HAIRLINE,
  INFO,
  INK,
  LEFT,
  MUTED,
  NOT_AVAILABLE,
  RIGHT,
  sectionLabel,
  type Sheet,
  SUCCESS,
  TEAL,
  WARNING,
  WIDTH,
} from '@/lib/documents/sheet'
import { treatmentGoalStatus, treatmentPlanStatus } from '@/lib/status'

/**
 * Module 3.5, "Download Treatment Plan as PDF" - and what Print prints.
 *
 * The plans the patient's Treatment plan page shows, on the same RecoverEase
 * sheet as the prescription (`@/lib/documents/sheet`): the letterhead, the
 * patient, then one plan per page - its status, its period, the doctor who
 * wrote it, what it is about, how many of its goals are achieved, and its
 * goals in the order they are due, each with its target date and its state
 * in words. A long plan carries on to further pages under a slim letterhead,
 * and every page is numbered.
 *
 * Only what the records hold: no advice, outcome or signature is added. The
 * plan's doctor is named only when the reader may read them - for a patient,
 * their current doctor - and is "Not available" otherwise.
 *
 * Built in the browser from what the page has loaded, and handed straight to
 * the download or the print dialog - nothing is uploaded or stored.
 */
export type TreatmentPlanDocumentInput = {
  patient: Pick<
    Patient,
    'pat_first_name' | 'pat_last_name' | 'pat_birth_date' | 'pat_gender'
  >
  /** The doctors the reader may read. A plan names its doctor only when they are here. */
  doctors: readonly (PrescriberDetails | null | undefined)[]
  /** The reader's clinic, when it could be read; left off the letterhead otherwise. */
  clinicName: string | null
  plans: PlanWithGoals[]
  generatedAt: Date
}

const GOAL_COLOUR: Record<TreatmentGoalStatus, Colour> = {
  achieved: SUCCESS,
  in_progress: INFO,
  pending: MUTED,
  missed: WARNING,
}

/** "1 Oct 2026 to 30 Nov 2026", or "1 Oct 2026 onwards". */
export function planPeriod(
  plan: Pick<PlanWithGoals, 'treatment_plan_start_date' | 'treatment_plan_end_date'>,
): string {
  const start = reportDate(plan.treatment_plan_start_date)
  return plan.treatment_plan_end_date
    ? `${start} to ${reportDate(plan.treatment_plan_end_date)}`
    : `${start} onwards`
}

function continuePlan(sheet: Sheet, plan: PlanWithGoals) {
  drawContinuation(sheet, 'Treatment plan, continued', plan.treatment_plan_title)
}

/** A labelled field on the right of the plan's heading. */
function field(sheet: Sheet, name: string, value: string, x: number, top: number, width: number) {
  sheet.write(name, x, top, { size: 10, color: MUTED })
  sheet.box(x, top - 6, width, 24, { fill: FIELD, border: HAIRLINE })
  sheet.write(value, x + 10, top - 22, { size: 11 })
}

/** The plan's title and doctor on the left; status, period and goals on the right. */
function drawPlanHeading(sheet: Sheet, plan: PlanWithGoals, doctor: PrescriberDetails | null) {
  const { bold } = sheet.fonts
  const top = sheet.y
  const fieldX = 330
  const fieldWidth = RIGHT - fieldX
  const titleWidth = fieldX - LEFT - 18

  sectionLabel(sheet, 'Treatment plan', LEFT, top)
  let y = top - 24
  for (const line of wrapText(plan.treatment_plan_title, bold, 18, titleWidth)) {
    sheet.write(line, LEFT, y, { font: bold, size: 18 })
    y -= 22
  }
  y -= 4
  sheet.write('Doctor', LEFT, y, { size: 9.5, color: MUTED })
  y -= 16
  sheet.write(doctor ? prescriberName(doctor) : NOT_AVAILABLE, LEFT, y, { font: bold, size: 12 })
  y -= 15
  if (doctor?.doc_specialization) {
    sheet.write(doctor.doc_specialization, LEFT, y, { size: 10, color: BODY })
    y -= 15
  }

  const progress = summariseGoals(plan.treatment_goal)
  field(sheet, 'Status', treatmentPlanStatus[plan.treatment_plan_status].label, fieldX, top, fieldWidth)
  field(sheet, 'Plan period', planPeriod(plan), fieldX, top - 44, fieldWidth)
  field(
    sheet,
    'Goals achieved',
    progress.total > 0 ? `${progress.achieved} of ${progress.total}` : 'No goals yet',
    fieldX,
    top - 88,
    fieldWidth,
  )

  sheet.y = Math.min(y, top - 120) - 4
  sheet.line(LEFT, RIGHT, sheet.y)
  sheet.y -= 22
}

/** What the plan is about, in the doctor's words. */
function drawDescription(sheet: Sheet, plan: PlanWithGoals) {
  const { regular } = sheet.fonts
  const paragraphs = (plan.treatment_plan_description ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => wrapText(text, regular, 10.5, WIDTH))

  // The label never sits alone at the foot of a page.
  if (!sheet.fits(22 + Math.min(3, Math.max(1, paragraphs.flat().length)) * 15)) {
    sheet.newPage()
    continuePlan(sheet, plan)
  }
  sectionLabel(sheet, 'About this plan', LEFT, sheet.y)
  sheet.y -= 20
  if (paragraphs.length === 0) {
    sheet.write('No description recorded.', LEFT, sheet.y, { size: 10.5, color: MUTED })
    sheet.y -= 15
  }
  for (const lines of paragraphs) {
    for (const text of lines) {
      if (!sheet.fits(15)) {
        sheet.newPage()
        continuePlan(sheet, plan)
      }
      sheet.write(text, LEFT, sheet.y, { size: 10.5, color: BODY })
      sheet.y -= 15
    }
    sheet.y -= 4
  }
  sheet.y -= 18
}

/** How many goals are achieved, as a bar drawn from that count and nothing else. */
function drawProgress(sheet: Sheet, plan: PlanWithGoals) {
  const progress = summariseGoals(plan.treatment_goal)
  if (progress.total === 0) return
  if (!sheet.fits(56)) {
    sheet.newPage()
    continuePlan(sheet, plan)
  }
  sectionLabel(sheet, 'Progress', LEFT, sheet.y)
  sheet.writeRight(
    `${progress.achieved} of ${progress.total} goals achieved (${progress.percentage ?? 0}%)`,
    RIGHT,
    sheet.y,
    { size: 10.5, color: BODY },
  )
  const barTop = sheet.y - 12
  sheet.box(LEFT, barTop, WIDTH, 10, { fill: FIELD, border: BORDER, radius: 5 })
  if (progress.achieved > 0) {
    sheet.box(LEFT, barTop, (WIDTH * progress.achieved) / progress.total, 10, {
      fill: TEAL,
      radius: 5,
    })
  }
  sheet.y = barTop - 34
}

/** The goals, in the order they are due, each with its target date and state. */
function drawGoals(sheet: Sheet, plan: PlanWithGoals) {
  const goals = [...plan.treatment_goal].sort(byTargetDate)
  // The label, the table's header and its first row stay together.
  if (!sheet.fits(90)) {
    sheet.newPage()
    continuePlan(sheet, plan)
  }
  sectionLabel(sheet, 'Goals', LEFT, sheet.y)
  sheet.y -= 14

  if (goals.length === 0) {
    sheet.y -= 6
    sheet.write('No goals have been set for this plan yet.', LEFT, sheet.y, {
      size: 10.5,
      color: MUTED,
    })
    sheet.y -= 15
    return
  }

  drawTable(
    sheet,
    [
      { title: 'Goal', share: 0.54 },
      { title: 'Target date', share: 0.22 },
      { title: 'Status', share: 0.24 },
    ],
    goals.map((goal) => [
      { text: goal.treatment_goal_description, bold: true, color: INK },
      {
        text: goal.treatment_goal_target_date
          ? reportDate(goal.treatment_goal_target_date)
          : 'No target date',
      },
      {
        text: treatmentGoalStatus[goal.treatment_goal_status].label,
        bold: true,
        color: GOAL_COLOUR[goal.treatment_goal_status],
      },
    ]),
    () => continuePlan(sheet, plan),
  )
  sheet.y -= 26
}

function drawPlan(sheet: Sheet, input: TreatmentPlanDocumentInput, plan: PlanWithGoals) {
  sheet.newPage()
  drawLetterhead(sheet, input.clinicName, 'Treatment plan')
  drawPatientBlock(sheet, input.patient, input.generatedAt)
  sheet.line(LEFT, RIGHT, sheet.y + 4)
  sheet.y -= 18
  drawPlanHeading(sheet, plan, prescriberOf(plan.doc_id, input.doctors))
  drawDescription(sheet, plan)
  drawProgress(sheet, plan)
  drawGoals(sheet, plan)
}

function drawNoPlan(sheet: Sheet, input: TreatmentPlanDocumentInput) {
  sheet.newPage()
  drawLetterhead(sheet, input.clinicName, 'Treatment plan')
  drawPatientBlock(sheet, input.patient, input.generatedAt)
  sheet.write('No treatment plan on record.', LEFT, sheet.y - 10, { size: 11, color: MUTED })
}

export async function buildTreatmentPlanPdf(
  input: TreatmentPlanDocumentInput,
): Promise<DownloadableFile> {
  const { doc, sheet } = await createSheetDocument('Treatment plan', input.generatedAt)

  if (input.plans.length === 0) drawNoPlan(sheet, input)
  for (const plan of input.plans) drawPlan(sheet, input, plan)

  drawFooters(sheet, 'treatment plan', input.generatedAt)

  return {
    bytes: await doc.save(),
    mimeType: PDF_TYPE,
    fileName: documentFileName(
      ['treatment-plan', input.patient.pat_first_name, input.patient.pat_last_name],
      input.generatedAt,
      'pdf',
    ),
  }
}
