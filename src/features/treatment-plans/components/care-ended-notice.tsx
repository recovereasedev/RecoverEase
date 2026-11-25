import { CalendarPlus } from 'lucide-react'
import { Link } from 'react-router-dom'

import { buttonVariants } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'

/**
 * What a patient sees where care actions used to be, once their doctor has
 * discharged them (migration 63: the patient's own care status, never their
 * plans). Their account, history and appointments are untouched; booking
 * stays open.
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
      Your care has ended. Book a follow-up if you need more care.
    </Notice>
  )
}
