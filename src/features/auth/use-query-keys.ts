import { queryKeysFor, type QueryKeys } from '@/lib/query-keys'

import { useCurrentUser } from './auth-context'

/**
 * The query keys of the signed-in account: every key a screen reads or
 * invalidates starts with this account's id. See `queryKeysFor`.
 *
 * Like `useCurrentUser`, it throws outside an authenticated route. A query
 * that runs for nobody in particular has no owner to file its result under.
 */
export function useQueryKeys(): QueryKeys {
  return queryKeysFor(useCurrentUser().userId)
}
