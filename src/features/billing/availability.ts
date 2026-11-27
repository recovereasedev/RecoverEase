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
