import type { Patient } from '@/features/patients/api'
import { reportDate, reportDateTime } from '@/features/reports/report-format'
import {
  byTargetDate,
  summariseGoals,
  type PlanWithGoals,
} from '@/features/treatment-plans/api'
import {
  documentFileName,
  PDF_TYPE,
  type DownloadableFile,
} from '@/lib/documents/download'
import { renderPdf, type PdfBlock } from '@/lib/documents/pdf'
import { treatmentGoalStatus, treatmentPlanStatus } from '@/lib/status'
import { fullName } from '@/lib/utils'

/**
 * Module 3.5, "Download Treatment Plan as PDF".
 *
 * The plans the patient's Treatment plan page shows - each with its status,
 * dates, description and how many goals are achieved, then its goals in the
 * order they are due with their target dates and states - from the plans the
 * page has already loaded. Every state is written in words, as on screen.
 */
export type TreatmentPlanDocumentInput = {
  patient: Pick<Patient, 'pat_first_name' | 'pat_last_name'>
  plans: PlanWithGoals[]
  generatedAt: Date
}

export function treatmentPlanBlocks(input: TreatmentPlanDocumentInput): PdfBlock[] {
  const blocks: PdfBlock[] = [
    {
      kind: 'facts',
      items: [
        {
          label: 'Patient',
          value: fullName(input.patient.pat_first_name, input.patient.pat_last_name),
        },
      ],
    },
  ]

  if (input.plans.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No treatment plan yet.', tone: 'muted' })
    return blocks
  }

  for (const plan of input.plans) {
    const progress = summariseGoals(plan.treatment_goal)
    blocks.push({ kind: 'heading', text: plan.treatment_plan_title })
    blocks.push({
      kind: 'facts',
      items: [
        { label: 'Status', value: treatmentPlanStatus[plan.treatment_plan_status].label },
        {
          label: 'Dates',
          value: `${reportDate(plan.treatment_plan_start_date)}${
            plan.treatment_plan_end_date
              ? ` to ${reportDate(plan.treatment_plan_end_date)}`
              : ' onwards'
          }`,
        },
        ...(progress.total > 0
          ? [{ label: 'Goals achieved', value: `${progress.achieved} of ${progress.total}` }]
          : []),
      ],
    })
    if (plan.treatment_plan_description) {
      blocks.push({ kind: 'paragraph', text: plan.treatment_plan_description })
    }

    blocks.push({ kind: 'subheading', text: 'Goals' })
    const goals = [...plan.treatment_goal].sort(byTargetDate)
    if (goals.length === 0) {
      blocks.push({
        kind: 'paragraph',
        text: 'No goals have been set for this plan yet.',
        tone: 'muted',
      })
      continue
    }
    for (const goal of goals) {
      blocks.push({
        kind: 'item',
        title: goal.treatment_goal_description,
        lines: [
          `${
            goal.treatment_goal_target_date
              ? `By ${reportDate(goal.treatment_goal_target_date)}`
              : 'No target date'
          } · ${treatmentGoalStatus[goal.treatment_goal_status].label}`,
        ],
      })
    }
  }
  return blocks
}

export async function buildTreatmentPlanPdf(
  input: TreatmentPlanDocumentInput,
): Promise<DownloadableFile> {
  const generated = reportDateTime(input.generatedAt.toISOString())
  const bytes = await renderPdf({
    title: 'Treatment plan',
    subtitle: 'As recorded in RecoverEase',
    meta: [{ label: 'Generated', value: generated }],
    blocks: treatmentPlanBlocks(input),
    footer: `RecoverEase treatment plan · Generated ${generated}`,
    generatedAt: input.generatedAt,
  })
  return {
    bytes,
    mimeType: PDF_TYPE,
    fileName: documentFileName(
      ['treatment-plan', input.patient.pat_first_name, input.patient.pat_last_name],
      input.generatedAt,
      'pdf',
    ),
  }
}
