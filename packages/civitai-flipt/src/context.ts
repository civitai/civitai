/**
 * Targeting properties for a Flipt evaluation.
 *
 * 🔴 Segment constraints match on THESE properties, never on `entityId` — that is only the
 * percentage-rollout hash input. An evaluation called without a context therefore matches no
 * segment and falls through to the flag's `enabled` value, which for every segmented boolean
 * flag here is `false`. That reads as "the rollout is missing" and is how creator-announcements
 * and scheduled-model-sales were dark for every Creator Studio user, moderators included.
 */
export type FliptTargetUser = {
  id: number | string;
  isModerator?: boolean;
  tier?: string;
  isEarlyAdopter?: boolean;
};

export function buildFliptContext(
  user?: FliptTargetUser | null,
  extra?: Record<string, string>
): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (user) {
    ctx.userId = String(user.id);
    ctx.isModerator = String(!!user.isModerator);
    ctx.tier = user.tier ?? 'free';
    ctx.isLoggedIn = 'true';
    ctx.isMember = String(!!user.tier && user.tier !== 'free');
    // Always emitted for a logged-in user (never opted in ⇒ 'false') so a segment can match on
    // the string equally rather than on key presence — same shape as `isModerator`.
    ctx.isEarlyAdopter = String(!!user.isEarlyAdopter);
  } else {
    ctx.isLoggedIn = 'false';
  }
  const deploymentId = process.env.FLIPT_DEPLOYMENT_ID;
  if (deploymentId) ctx.deploymentId = deploymentId;
  return extra ? { ...ctx, ...extra } : ctx;
}
