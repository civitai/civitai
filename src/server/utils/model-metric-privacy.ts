/**
 * Creator Controls: model metric privacy.
 *
 * A Creator Program member can hide three public model metrics — tipped/earned
 * Buzz, download count, generation count — at three levels:
 *   - USER default (User.settings JSON): baseline for all of the creator's models
 *   - MODEL level (Model.meta JSON): governs the model-page top stats + model card
 *   - VERSION level (ModelVersion.meta JSON): governs the per-version stats in the
 *     version details card only
 *
 * The stored flags only take effect while the model OWNER currently holds a valid
 * Creator Program membership. Effective visibility is therefore computed PER VIEWER
 * at READ time = storedFlag AND hasValidCreatorMembership(ownerId); a lapsed
 * creator's flags silently revert to visible with NO database write. Owners and
 * moderators always see their own real stats (bypass). This mirrors the read-time
 * gate used by the donation-goals opt-out (see `redis/donation-goals-cache.ts`).
 *
 * This module is intentionally dependency-light (no db/redis/env imports) so the
 * precedence rules can be unit-tested directly against the real functions.
 */

export const modelMetricPrivacyKeys = ['buzz', 'downloads', 'generations'] as const;
export type ModelMetricPrivacyKey = (typeof modelMetricPrivacyKeys)[number];

export type HiddenModelMetrics = { buzz: boolean; downloads: boolean; generations: boolean };

const NONE_HIDDEN: HiddenModelMetrics = { buzz: false, downloads: false, generations: false };

/** Whether any of the three metrics is hidden. */
export const anyMetricHidden = (hidden: HiddenModelMetrics) =>
  hidden.buzz || hidden.downloads || hidden.generations;

type MetaPrivacyFlags = {
  hideBuzz?: boolean | null;
  hideDownloads?: boolean | null;
  hideGenerations?: boolean | null;
};

type UserPrivacyDefaults = {
  hideModelBuzz?: boolean | null;
  hideModelDownloads?: boolean | null;
  hideModelGenerations?: boolean | null;
};

/** Reads the model/version-level hide flags off a `meta` JSON blob. */
export function getMetaMetricPrivacy(meta: unknown): HiddenModelMetrics {
  const m = (meta ?? {}) as MetaPrivacyFlags;
  return {
    buzz: !!m.hideBuzz,
    downloads: !!m.hideDownloads,
    generations: !!m.hideGenerations,
  };
}

/** Reads the user-default hide flags off a User.settings JSON blob. */
export function getUserMetricPrivacyDefaults(settings: unknown): HiddenModelMetrics {
  const s = (settings ?? {}) as UserPrivacyDefaults;
  return {
    buzz: !!s.hideModelBuzz,
    downloads: !!s.hideModelDownloads,
    generations: !!s.hideModelGenerations,
  };
}

const orHidden = (...parts: HiddenModelMetrics[]): HiddenModelMetrics => ({
  buzz: parts.some((p) => p.buzz),
  downloads: parts.some((p) => p.downloads),
  generations: parts.some((p) => p.generations),
});

/**
 * Effective hidden metrics for the model-page TOP stats + the model card.
 * Governed by the MODEL flag OR the USER default. Bypassed for owner/mod and when
 * the owner has no valid Creator Program membership.
 */
export function resolveModelHiddenMetrics(args: {
  modelMeta?: unknown;
  userSettings?: unknown;
  isOwnerOrModerator?: boolean;
  hasValidMembership?: boolean;
}): HiddenModelMetrics {
  if (args.isOwnerOrModerator || !args.hasValidMembership) return { ...NONE_HIDDEN };
  return orHidden(
    getMetaMetricPrivacy(args.modelMeta),
    getUserMetricPrivacyDefaults(args.userSettings)
  );
}

/**
 * Effective hidden metrics for the per-version stats in the version details card.
 * A version-details stat is hidden if the VERSION flag OR the MODEL flag OR the
 * USER default says so. Bypassed for owner/mod and lapsed/non-members.
 */
export function resolveVersionHiddenMetrics(args: {
  versionMeta?: unknown;
  modelMeta?: unknown;
  userSettings?: unknown;
  isOwnerOrModerator?: boolean;
  hasValidMembership?: boolean;
}): HiddenModelMetrics {
  if (args.isOwnerOrModerator || !args.hasValidMembership) return { ...NONE_HIDDEN };
  return orHidden(
    getMetaMetricPrivacy(args.versionMeta),
    getMetaMetricPrivacy(args.modelMeta),
    getUserMetricPrivacyDefaults(args.userSettings)
  );
}
