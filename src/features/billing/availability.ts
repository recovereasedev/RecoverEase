/**
 * Whether this build offers online checkout (PayMongo) on the Clinic Admin's
 * Subscription page.
 *
 * Off unless the build sets VITE_PAYMONGO_CHECKOUT_ENABLED to exactly
 * "true". Production leaves it unset until the `paymongo-checkout` and
 * `paymongo-webhook` functions and their secrets are set up, so its Clinic
 * Admins are never shown a Subscribe button that cannot work. Staging and
 * local sandbox testing set it (docs/paymongo-staging.md). It only hides the
 * buttons: the database and the functions enforce every rule regardless.
 */
export function isOnlineCheckoutEnabled(): boolean {
  return import.meta.env['VITE_PAYMONGO_CHECKOUT_ENABLED'] === 'true'
}

/**
 * Whether this build offers the internal demo payment simulator (migration
 * 70): "Try Demo Checkout" on Basic and Premium, a RecoverEase-only checkout
 * that records a simulated payment. No payment provider is involved.
 *
 * Off unless the build sets VITE_DEMO_PAYMENT_SIMULATOR_ENABLED to exactly
 * "true", and independent of VITE_PAYMONGO_CHECKOUT_ENABLED. Like that
 * switch it only hides the button: the database decides who may use the
 * simulator (one allowed clinic, its Clinic Admin, switched on), and the
 * page also asks the database before showing it.
 */
export function isDemoPaymentSimulatorEnabled(): boolean {
  return import.meta.env['VITE_DEMO_PAYMENT_SIMULATOR_ENABLED'] === 'true'
}
