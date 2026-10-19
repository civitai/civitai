import {
  getMetaMetricPrivacy,
  getUserMetricPrivacyDefaults,
  modelMetricPrivacyKeys,
  type ModelMetricPrivacyKey,
} from '~/server/utils/model-metric-privacy';

export const HIDDEN_BY_ACCOUNT_DEFAULT =
  'Already hidden on all your models by your account default.';
export const HIDDEN_BY_MODEL = 'Already hidden for this whole model.';

/**
 * Why a metric toggle that reads "off" is hidden anyway. Hidden metrics are OR'd across the account
 * default, the model and the version (see resolveVersionHiddenMetrics), so a switch left off can still
 * be hidden by a level above it. The account default applies only to the owner's own models: a
 * moderator's settings say nothing about the model they are editing.
 */
export function inheritedMetricPrivacyHints({
  userSettings,
  modelMeta,
  isOwner,
}: {
  userSettings?: unknown;
  modelMeta?: unknown;
  isOwner: boolean;
}): Partial<Record<ModelMetricPrivacyKey, string>> {
  const account = isOwner ? getUserMetricPrivacyDefaults(userSettings) : null;
  const model = modelMeta ? getMetaMetricPrivacy(modelMeta) : null;
  const hints: Partial<Record<ModelMetricPrivacyKey, string>> = {};
  for (const key of modelMetricPrivacyKeys) {
    if (account?.[key]) hints[key] = HIDDEN_BY_ACCOUNT_DEFAULT;
    else if (model?.[key]) hints[key] = HIDDEN_BY_MODEL;
  }
  return hints;
}
