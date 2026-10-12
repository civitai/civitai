import type { BearerCredential } from '~/server/auth/full-user-credential';
import type { EventViewer } from '~/server/events/event-access';
import { isSessionOrFullUserKey } from '~/server/services/oauth/enforce-token-scope';

/**
 * The viewer an event gate is asked about for this request. A moderator is in every event's flag
 * audience, so as for moderatorProcedure that holds only for a session or a full-access personal
 * key: a scoped or OAuth token reads as the user alone.
 */
export function eventViewerOf(
  ctx: BearerCredential & {
    apiKeyId?: number | null;
    user?: { id: number; isModerator?: boolean } | null;
  }
): NonNullable<EventViewer> {
  return {
    id: ctx.user?.id,
    isModerator: !!ctx.user?.isModerator && isSessionOrFullUserKey(ctx),
  };
}
