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

/**
 * How a user came to their arm. Only `rule` is a randomised assignment; the readout drops the rest.
 * - `pinned`: a Flipt segment whose key starts with `EXPERIMENT_PIN_SEGMENT_PREFIX` matched.
 * - `override`: a moderator's preview cookie, or a dev `FLIPT_LOCAL_OVERRIDES` entry.
 * - `unavailable`: Flipt not initialised, or the flag key missing from flag state.
 * - `off`: the flag is disabled, or no rule matched.
 * - `invalid`: Flipt returned a variant this registry does not list.
 */
export type ExperimentAssignmentSource =
  | 'rule'
  | 'pinned'
  | 'override'
  | 'unavailable'
  | 'off'
  | 'invalid';

export type ExperimentAssignment = { variant: string; assignment: ExperimentAssignmentSource };
export type ExperimentAssignments = Record<ExperimentKey, ExperimentAssignment>;

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
    if (key in experiments && isExperimentVariant(key as ExperimentKey, variant)) {
      out[key as ExperimentKey] = variant;
    }
  }
  return out;
}
