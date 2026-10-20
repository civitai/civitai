import {
  getMetaMetricVisibility,
  getUserMetricPrivacyDefaults,
  modelMetricPrivacyKeys,
  type HiddenModelMetrics,
  type ModelMetricPrivacyKey,
} from '~/server/utils/model-metric-privacy';

/** Where an inheriting metric's state comes from, for the line shown above the override. */
export type InheritedMetricSource = 'account' | 'model' | 'owner';
export type InheritedMetricState = { hidden: boolean | null; source: InheritedMetricSource };

/**
 * What each metric would be if this model or version inherited it: the level above's setting,
 * resolved the way the server resolves it (nearest explicit wins). The account default is known
 * only for the editor's own models; a moderator editing someone else's sees `hidden: null` with
 * source `owner`, since the owner's default is not loaded here.
 */
export function inheritedMetricPrivacy({
  level,
  userSettings,
  modelMeta,
  isOwner,
  ownerDefaults,
}: {
  level: 'model' | 'version';
  userSettings?: unknown;
  modelMeta?: unknown;
  isOwner: boolean;
  /** The owner's account defaults, served to a moderator with the model; absent for anyone else. */
  ownerDefaults?: HiddenModelMetrics | null;
}): Record<ModelMetricPrivacyKey, InheritedMetricState> {
  const account = isOwner ? getUserMetricPrivacyDefaults(userSettings) : null;
  const model = level === 'version' ? getMetaMetricVisibility(modelMeta) : {};
  const states = {} as Record<ModelMetricPrivacyKey, InheritedMetricState>;
  for (const key of modelMetricPrivacyKeys) {
    const modelSetting = model[key];
    if (modelSetting) states[key] = { hidden: modelSetting === 'hide', source: 'model' };
    else if (account) states[key] = { hidden: account[key], source: 'account' };
    else states[key] = { hidden: ownerDefaults ? ownerDefaults[key] : null, source: 'owner' };
  }
  return states;
}

export function metricPrivacyAccessFor({
  isOwner,
  ownerHasMembership,
}: {
  isOwner: boolean;
  ownerHasMembership: boolean;
}): 'owner' | 'owner-inactive' | 'moderator' {
  if (!isOwner) return 'moderator';
  return ownerHasMembership ? 'owner' : 'owner-inactive';
}
