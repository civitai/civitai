import { dbWrite } from '~/server/db/client';
import { isFlipt } from '~/server/flipt/client';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import { feedbackAreaFlagKey } from '~/shared/constants/feedback.constants';
import type { SessionUser } from '~/types/session';

/**
 * entityId for an evaluation with no user. Only percentage rollouts read it, and
 * every anonymous request shares this one value, so a percentage rollout is
 * all-or-nothing for anonymous traffic — deliberate, and unchanged by the context
 * work below.
 */
const ANONYMOUS_ENTITY_ID = 'anonymous';

/**
 * Is this feedback area collecting right now, for THIS user?
 *
 * Takes the SessionUser rather than a bare id because the third argument below is
 * the whole point: Flipt matches a segment against the EVALUATION CONTEXT, so a
 * flag whose rollout targets a cohort (`isEarlyAdopter`, `tier`, `isModerator`, …)
 * can only ever match if that context is sent. Passing entityId alone leaves the
 * context empty, and an empty context matches no segment — every rollout then
 * collapses to the flag's own default, i.e. the area looks off for the cohort it
 * was just switched on for. Nothing errors; it silently reads as "nobody matches".
 *
 * The context comes from the SAME `buildFliptContext` the client gate
 * (`getFeatureFlags`) uses, so the two gates cannot resolve a user differently.
 *
 * No user → an honest anonymous context (`isLoggedIn: 'false'`, and no cohort
 * properties at all), so a cohort-segmented area can never match anonymously.
 */
export async function isFeedbackAreaEnabled({
  area,
  user,
}: {
  area: FeedbackArea;
  user?: SessionUser;
}) {
  // isEnabled, not getBoolean: getBoolean deliberately ignores
  // FLIPT_LOCAL_OVERRIDES, so an area could never be switched on locally.
  return isFlipt(
    feedbackAreaFlagKey(area),
    user ? String(user.id) : ANONYMOUS_ENTITY_ID,
    buildFliptContext(user)
  );
}

export async function createFeedback({
  userId,
  area,
  message,
  context,
}: CreateFeedbackInput & { userId: number }) {
  return dbWrite.feedback.create({
    data: { userId, area, message, context: context ?? {} },
    select: { id: true },
  });
}
