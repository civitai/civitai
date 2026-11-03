// UI experiments on Flipt variant flags. Code owns each experiment's arms and default: a variant
// key Flipt returns that is not listed here renders the default, so a typo in flag state can never
// render an arm nobody built. Arms change UI only, never scoring, supply or eligibility.
//
// Keep a flag's distribution fixed for the life of an experiment: Flipt buckets on
// hash(flagKey + userId), so editing the split moves users between arms. A new split is a new key.

type ExperimentDef = {
  fliptKey: string;
  variants: readonly [string, ...string[]];
  defaultVariant: string;
};

export const experiments = {
  hatTurfImageDetail: {
    fliptKey: 'exp-hat-turf-image-detail',
    variants: ['control', 'invite-inline'],
    defaultVariant: 'control',
  },
  hatTurfFeedCard: {
    fliptKey: 'exp-hat-turf-feed-card',
    variants: ['control', 'count-button'],
    defaultVariant: 'control',
  },
} as const satisfies Record<string, ExperimentDef>;

export type ExperimentKey = keyof typeof experiments;
export type ExperimentVariant<K extends ExperimentKey> =
  (typeof experiments)[K]['variants'][number];
export const experimentKeys = Object.keys(experiments) as ExperimentKey[];

// How a user came to their arm. Only `rule` is randomised; the readout drops the rest.
export const EXPERIMENT_ASSIGNMENT_SOURCES = [
  'rule',
  'pinned',
  'override',
  'unavailable',
  'off',
  'invalid',
] as const;
export type ExperimentAssignmentSource = (typeof EXPERIMENT_ASSIGNMENT_SOURCES)[number];

export type ExperimentAssignment = { variant: string; assignment: ExperimentAssignmentSource };
export type ExperimentAssignments = Record<ExperimentKey, ExperimentAssignment>;

export const EXPERIMENT_SURFACES = ['image-detail', 'feed-card'] as const;
export type ExperimentSurface = (typeof EXPERIMENT_SURFACES)[number];

export const HAT_TURF_CLIENT_ACTIONS = [
  'invite_view',
  'invite_dismiss',
  'hat_count_open',
  'feed_place_start',
  'feed_place_save',
  'hide_all_hats_on',
  'hide_all_hats_off',
] as const;
export const HAT_TURF_SERVER_ACTIONS = ['opt_in', 'opt_out'] as const;

export const EXPERIMENT_PIN_SEGMENT_PREFIX = 'exp-pin-';

/** Moderator-only preview: `civ-exp=hatTurfFeedCard:count-button,hatTurfImageDetail:control`. */
export const EXPERIMENT_OVERRIDE_COOKIE = 'civ-exp';

export function isExperimentVariant<K extends ExperimentKey>(
  key: K,
  variant: string | null | undefined
): variant is ExperimentVariant<K> {
  return variant != null && (experiments[key].variants as readonly string[]).includes(variant);
}

export function parseExperimentOverrides(
  raw: string | undefined
): Partial<Record<ExperimentKey, string>> {
  const out: Partial<Record<ExperimentKey, string>> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const [key, variant] = pair.split(':').map((s) => s.trim());
    if (Object.hasOwn(experiments, key) && isExperimentVariant(key as ExperimentKey, variant)) {
      out[key as ExperimentKey] = variant;
    }
  }
  return out;
}
