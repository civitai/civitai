import { canAccess } from '$lib/server/access';
import {
  MODEL_FLAGS_APPEALS_PATH,
  MODEL_FLAGS_AUTO_PATH,
  MODEL_FLAGS_NEEDS_REVIEW_PATH,
} from '$lib/minor-flags/paths';

type User = Parameters<typeof canAccess>[0];

/** The minor-flag API endpoints serve all three Model Flags tabs, and `/api/*` skips the global gate. */
export const canAccessMinorQueue = (user: User) =>
  [MODEL_FLAGS_APPEALS_PATH, MODEL_FLAGS_AUTO_PATH, MODEL_FLAGS_NEEDS_REVIEW_PATH].some((path) =>
    canAccess(user, path)
  );
