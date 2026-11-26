/**
 * Money is stored, sent and summed as whole centavos (migration 68). It is
 * turned into pesos only here, for display, so no figure is ever rounded on
 * its way through the app.
 */
const peso = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 99900 → "₱999.00". */
export function formatCentavos(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) throw new Error('Not a whole number of centavos')
  // Integer division keeps the peso part exact; only the display adds a point.
  const sign = centavos < 0 ? -1 : 1
  const abs = Math.abs(centavos)
  return peso.format(sign * (Math.trunc(abs / 100) + (abs % 100) / 100))
}

/** A plan's list price for display: Free, a monthly price, or Custom pricing. */
export function formatPlanPrice(plan: {
  priceCentavos: number | null
  billingInterval: 'forever' | 'month' | 'custom'
}): string {
  if (plan.priceCentavos === null || plan.billingInterval === 'custom') return 'Custom pricing'
  if (plan.priceCentavos === 0) return '₱0 · free forever'
  return `${formatCentavos(plan.priceCentavos)} / month`
}
