import { CalendarPlus } from 'lucide-react'
import { Link } from 'react-router-dom'

import { buttonVariants } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'

/**
 * What a patient sees where care-plan actions used to be, once their doctor
 * has discharged them and no other plan is open (migration 57). Their
 * account, history and appointments are untouched; booking stays open.
 */
export function CareEndedNotice() {
  return (
    <Notice
      tone="info"
      action={
        <Link to="/patient/appointments" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          <CalendarPlus aria-hidden="true" />
          Book a follow-up
        </Link>
      }
    >
      Your care plan has ended. Book a follow-up if you need more care.
    </Notice>
  )
}
