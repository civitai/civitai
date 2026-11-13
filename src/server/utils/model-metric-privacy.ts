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

import * as z from 'zod';

export const modelMetricPrivacyKeys = ['buzz', 'downloads', 'generations'] as const;
export type ModelMetricPrivacyKey = (typeof modelMetricPrivacyKeys)[number];

export type HiddenModelMetrics = { buzz: boolean; downloads: boolean; generations: boolean };

const NONE_HIDDEN: HiddenModelMetrics = { buzz: false, downloads: false, generations: false };

/**
 * A fresh, fully-visible ("nothing hidden") result. Returned by the read-time gate
 * (`gateHiddenMetrics`) when the `modelMetricPrivacyReadtime` flag is OFF, so a
 * gated surface emits its RAW metrics without running any membership / resolver
 * work. Always a NEW object (never the shared `NONE_HIDDEN` ref) to match the
 * fresh-object contract of `resolveModel/VersionHiddenMetrics`.
 */
export const noHiddenMetrics = (): HiddenModelMetrics => ({
  buzz: false,
  downloads: false,
  generations: false,
});

/**
 * Read-time flag gate for the Creator-Controls metric-privacy resolution.
 *
 * When `enabled` is true the caller's `resolve` thunk runs and its result is
 * returned UNCHANGED (byte-identical to calling the resolver directly). When
 * `enabled` is false the thunk is NOT invoked at all — no resolver, and (because
 * the caller only builds the resolver's inputs inside a matching `if (enabled)`
 * guard) none of the batched membership / owner-settings lookups either — and a
 * fresh all-visible result is returned (raw metrics, i.e. pre-#3266 visibility).
 *
 * This is the single choke-point that lets `modelMetricPrivacyReadtime` be flipped
 * OFF to skip #3266's added synchronous read-time work for a controlled A/B.
 */
export function gateHiddenMetrics(
  enabled: boolean,
  resolve: () => HiddenModelMetrics
): HiddenModelMetrics {
  if (!enabled) return noHiddenMetrics();
  return resolve();
}

/** Whether any of the three metrics is hidden. */
export const anyMetricHidden = (hidden: HiddenModelMetrics) =>
  hidden.buzz || hidden.downloads || hidden.generations;

/** A model or version's explicit setting for one metric. Absent means inherit from the level above. */
export type MetricVisibility = 'hide' | 'show';
export type MetricVisibilitySettings = Partial<Record<ModelMetricPrivacyKey, MetricVisibility>>;

type MetaPrivacyFlags = {
  metricVisibility?: Partial<Record<ModelMetricPrivacyKey, MetricVisibility | null>> | null;
  // Legacy booleans: `true` reads as hide, `false` or absent as inherit. Under the old OR rule an
  // explicit false changed nothing, so this mapping leaves every stored combination as it was.
  hideBuzz?: boolean | null;
  hideDownloads?: boolean | null;
  hideGenerations?: boolean | null;
};

const LEGACY_HIDE_KEY = {
  buzz: 'hideBuzz',
  downloads: 'hideDownloads',
  generations: 'hideGenerations',
} as const satisfies Record<ModelMetricPrivacyKey, keyof MetaPrivacyFlags>;

type UserPrivacyDefaults = {
  hideModelBuzz?: boolean | null;
  hideModelDownloads?: boolean | null;
  hideModelGenerations?: boolean | null;
};

/** A model/version `meta` blob's explicit per-metric settings; `metricVisibility` wins over a legacy flag. */
export function getMetaMetricVisibility(meta: unknown): MetricVisibilitySettings {
  const m = (meta ?? {}) as MetaPrivacyFlags;
  const settings: MetricVisibilitySettings = {};
  for (const key of modelMetricPrivacyKeys) {
    const explicit = m.metricVisibility?.[key];
    if (explicit === 'hide' || explicit === 'show') settings[key] = explicit;
    else if (m[LEGACY_HIDE_KEY[key]]) settings[key] = 'hide';
  }
  return settings;
}

/**
 * Which metrics a model/version `meta` blob explicitly hides. Only a hide needs the owner's
 * membership checked (without one everything shows), so the membership short-circuits test this.
 */
export function getMetaMetricPrivacy(meta: unknown): HiddenModelMetrics {
  const settings = getMetaMetricVisibility(meta);
  return {
    buzz: settings.buzz === 'hide',
    downloads: settings.downloads === 'hide',
    generations: settings.generations === 'hide',
  };
}

/** What an editor offers per metric: `inherit` stores nothing, so the level above decides. */
export const metricVisibilityChoices = ['inherit', 'hide', 'show'] as const;
export type MetricVisibilityChoice = (typeof metricVisibilityChoices)[number];
/** Per-metric choices from an editor; `inherit` is stored as nothing. */
export const metricVisibilityChoicesSchema = z.object({
  buzz: z.enum(metricVisibilityChoices).nullish(),
  downloads: z.enum(metricVisibilityChoices).nullish(),
  generations: z.enum(metricVisibilityChoices).nullish(),
});

export type MetricVisibilityChoices = Partial<
  Record<ModelMetricPrivacyKey, MetricVisibilityChoice | null>
>;

/** An editor's starting choice for each metric, read the way the resolver reads it. */
export function getMetricVisibilityChoices(
  meta: unknown
): Record<ModelMetricPrivacyKey, MetricVisibilityChoice> {
  const settings = getMetaMetricVisibility(meta);
  return {
    buzz: settings.buzz ?? 'inherit',
    downloads: settings.downloads ?? 'inherit',
    generations: settings.generations ?? 'inherit',
  };
}

/**
 * The `meta` fields to merge in for a saved set of choices. The legacy flags are cleared: left in
 * place, a stale `hideX: true` would come back as a hide the moment the new setting was removed.
 */
export function metricVisibilityMetaFromChoices(choices: MetricVisibilityChoices) {
  const metricVisibility: MetricVisibilitySettings = {};
  for (const key of modelMetricPrivacyKeys) {
    const choice = choices[key];
    if (choice === 'hide' || choice === 'show') metricVisibility[key] = choice;
  }
  return { metricVisibility, hideBuzz: null, hideDownloads: null, hideGenerations: null };
}

/** The privacy fields of a `meta` blob, for callers that carry them apart from the rest of it. */
export function pickMetaMetricPrivacy(meta: unknown): MetaPrivacyFlags {
  const m = (meta ?? {}) as MetaPrivacyFlags;
  return {
    metricVisibility: m.metricVisibility ?? null,
    hideBuzz: m.hideBuzz ?? null,
    hideDownloads: m.hideDownloads ?? null,
    hideGenerations: m.hideGenerations ?? null,
  };
}

/** Reads the user-default hide flags off a User.settings JSON blob. */
/**
 * Only a moderator editing someone else's model is served the owner's defaults: the owner's are in
 * their own session, and anyone else must not see them.
 */
export function needsOwnerMetricPrivacyDefaults(
  viewer: { id: number; isModerator?: boolean | null } | null | undefined,
  ownerId: number
): boolean {
  return !!viewer?.isModerator && viewer.id !== ownerId;
}

export function getUserMetricPrivacyDefaults(settings: unknown): HiddenModelMetrics {
  const s = (settings ?? {}) as UserPrivacyDefaults;
  return {
    buzz: !!s.hideModelBuzz,
    downloads: !!s.hideModelDownloads,
    generations: !!s.hideModelGenerations,
  };
}

// The nearest level with an explicit setting decides; with none, the account default does.
function nearestExplicit(
  levels: MetricVisibilitySettings[],
  accountDefault: HiddenModelMetrics
): HiddenModelMetrics {
  const resolve = (key: ModelMetricPrivacyKey) => {
    const setting = levels.find((level) => level[key])?.[key];
    return setting ? setting === 'hide' : accountDefault[key];
  };
  return {
    buzz: resolve('buzz'),
    downloads: resolve('downloads'),
    generations: resolve('generations'),
  };
}

/**
 * Effective hidden metrics for the model-page TOP stats + the model card.
 * The MODEL's explicit setting wins, else the USER default. Bypassed for owner/mod and when
 * the owner has no valid Creator Program membership.
 */
export function resolveModelHiddenMetrics(args: {
  modelMeta?: unknown;
  userSettings?: unknown;
  isOwnerOrModerator?: boolean;
  hasValidMembership?: boolean;
}): HiddenModelMetrics {
  if (args.isOwnerOrModerator || !args.hasValidMembership) return { ...NONE_HIDDEN };
  return nearestExplicit(
    [getMetaMetricVisibility(args.modelMeta)],
    getUserMetricPrivacyDefaults(args.userSettings)
  );
}

/**
 * Effective hidden metrics for the per-version stats in the version details card.
 * The nearest explicit setting wins: VERSION, then MODEL, then the USER default, so a version set
 * to show reveals its own count under a model that hides. Bypassed for owner/mod and lapsed/non-members.
 */
export function resolveVersionHiddenMetrics(args: {
  versionMeta?: unknown;
  modelMeta?: unknown;
  userSettings?: unknown;
  isOwnerOrModerator?: boolean;
  hasValidMembership?: boolean;
}): HiddenModelMetrics {
  if (args.isOwnerOrModerator || !args.hasValidMembership) return { ...NONE_HIDDEN };
  return nearestExplicit(
    [getMetaMetricVisibility(args.versionMeta), getMetaMetricVisibility(args.modelMeta)],
    getUserMetricPrivacyDefaults(args.userSettings)
  );
}
