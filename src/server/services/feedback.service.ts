import { dbWrite } from '~/server/db/client';
import { isFlipt } from '~/server/flipt/client';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeatureAccess, FeatureFlagKey } from '~/server/services/feature-flags.service';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import {
  FEEDBACK_DEVICE_TEXT_MAX_LENGTH,
  FEEDBACK_USER_AGENT_MAX_LENGTH,
  feedbackAreaFlagKey,
} from '~/shared/constants/feedback.constants';
import type { SessionUser } from '~/types/session';

/**
 * entityId for an evaluation with no user. Only percentage rollouts read it, and
 * every anonymous request shares this one value, so a percentage rollout is
 * all-or-nothing for anonymous traffic — deliberate, and unchanged by the context
 * work below.
 */
const ANONYMOUS_ENTITY_ID = 'anonymous';

export const FEEDBACK_AREA_DISABLED_MESSAGE = 'Feedback is not being collected here right now.';

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

/**
 * Flags whose state changes what a page renders or how it loads, so a report says which variant
 * the reporter was on. Kept short on purpose: this is a triage hint, not a flag dump.
 */
export const FEEDBACK_STAMPED_FLAGS = [
  'assistant',
  'trpcBatching',
  'trpcUnifiedBatchWindow',
  'shellMaster',
  'shellImages',
  'shellDesignSystemMarkup',
  'modelPageDesignSystemMarkup',
  'mobileGenerator',
  'genTabDeferView',
  'siteSearchProxy',
] as const satisfies readonly FeatureFlagKey[];

export type FeedbackServerStamp = {
  userAgent?: string;
  tier?: string;
  site: string;
  host?: string;
  build?: string;
  flags: Partial<Record<(typeof FEEDBACK_STAMPED_FLAGS)[number], boolean>>;
};

const clipText = (value: unknown, max: number) =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined;

/**
 * What the server knows about the reporter at the moment they submit. Written into
 * `context.server`, which the input schema does not accept, so a client cannot write it through
 * the report body. Tier, site, build and flags are the server's own; `userAgent` and `host` are
 * request headers, so they are still the client's word and are for display, never for a decision.
 * Tier and flags are snapshotted because both change after the report.
 */
export function buildFeedbackServerStamp({
  headers,
  tier,
  domain,
  features,
}: {
  headers: { 'user-agent'?: string; host?: string };
  tier?: string;
  domain: string;
  features: FeatureAccess;
}): FeedbackServerStamp {
  const flags: FeedbackServerStamp['flags'] = {};
  for (const key of FEEDBACK_STAMPED_FLAGS) {
    try {
      flags[key] = !!features[key];
    } catch {
      // A flag that cannot be evaluated is left out rather than failing the report.
    }
  }
  const userAgent = clipText(headers['user-agent'], FEEDBACK_USER_AGENT_MAX_LENGTH);
  const host = clipText(headers.host, FEEDBACK_DEVICE_TEXT_MAX_LENGTH);
  const build = clipText(process.env.version, FEEDBACK_DEVICE_TEXT_MAX_LENGTH);
  return {
    ...(userAgent ? { userAgent } : {}),
    ...(tier ? { tier } : {}),
    site: domain,
    ...(host ? { host } : {}),
    ...(build ? { build } : {}),
    flags,
  };
}

export async function createFeedback({
  userId,
  area,
  message,
  context,
  server,
}: CreateFeedbackInput & { userId: number; server?: FeedbackServerStamp }) {
  return dbWrite.feedback.create({
    data: { userId, area, message, context: { ...(context ?? {}), ...(server ? { server } : {}) } },
    select: { id: true },
  });
}
