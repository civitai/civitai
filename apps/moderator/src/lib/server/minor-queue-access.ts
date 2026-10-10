import { canAccess } from '$lib/server/access';
import { FLAG_APPEALS_PATH, MINOR_HASH_PATH } from '$lib/minor-flags/paths';

type User = Parameters<typeof canAccess>[0];

/** The minor-flag API endpoints serve both pages, and `/api/*` skips the global gate. */
export const canAccessMinorQueue = (user: User) =>
  canAccess(user, MINOR_HASH_PATH) || canAccess(user, FLAG_APPEALS_PATH);
