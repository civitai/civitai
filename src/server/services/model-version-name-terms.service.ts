import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { matchSpec, type LabelRegexSpec } from '~/server/services/scanner-label-regex';

/**
 * The curated term list that decides whether a model version's NAME is worth an XGuard call.
 *
 * Two-stage by design: the term list SELECTS, the scan DECIDES. The list is cheap enough to run
 * on every save — it matched 2,620 of 1.2M version names in about two minutes with no network
 * calls — and it keeps the LLM off the 99.8% of names that are `v1.0` and `epoch2`.
 *
 * Read from sysRedis rather than a committed constant so a term that turns out to fire on
 * something innocent can be pulled without a deploy. The first sweep produced two such terms —
 * one collided with a model's own acronym, one with a vehicle chassis code.
 *
 * It also must NOT be committed. This repository is public and permanent, and "these are the
 * words we auto-flag on" is a decision rule an evader can route around — see CLAUDE.md →
 * Security. `local/model-name-terms.json` is a seed for this key, not the source of truth.
 */

const KEYS = REDIS_SYS_KEYS.MODEL_VERSION_NAME_MODERATION;

export type ModelVersionNameModerationConfig = {
  /**
   * Floor on the highest LEVEL-label score before a verdict is applied.
   *
   * Not a substitute for XGuard's own per-label thresholds — a second gate on top of them.
   * Measured over 2,000 random version names: XGuard returns `suggestive` between 0.55 and
   * 0.69 for contentless strings like `v1.0` or `IL_v1`, which clears its 0.50 threshold and
   * would flag four names in five. 98.3% of those scores sat in the 0.50-0.70 band; only 2 of
   * 2,000 reached 0.85. A short name gives the classifier almost nothing to read, so the floor
   * is what separates a verdict from the noise.
   */
  minScore: number;
};

/**
 * Deliberately high, and deliberately not 0.5. See `minScore` above — at the default trigger
 * this feature would flag on the classifier's floor behaviour rather than on its judgement.
 */
export const DEFAULT_MIN_SCORE = 0.85;

/** Empty means "no terms configured", which selects nothing — the safe failure for this path. */
const EMPTY_SPEC: LabelRegexSpec = { triggers: [] };

/**
 * Cached in-process for a minute. This is read on every version save, and the list changes at
 * human speed. A minute bounds how long a pulled term keeps firing.
 */
let cache: { spec: LabelRegexSpec; config: ModelVersionNameModerationConfig; at: number } | null =
  null;
const TTL_MS = 60_000;

export function __clearModelVersionNameTermsCache() {
  cache = null;
}

export async function getModelVersionNameTerms(): Promise<{
  spec: LabelRegexSpec;
  config: ModelVersionNameModerationConfig;
}> {
  if (cache && Date.now() - cache.at < TTL_MS) return { spec: cache.spec, config: cache.config };

  // Fails to EMPTY, not to a committed fallback: an unreachable Redis must scan nothing rather
  // than silently fall back to a list nobody can see or edit.
  const [rawSpec, rawConfig] = await Promise.all([
    sysRedis.packed.get<LabelRegexSpec>(KEYS.TERMS).catch(() => null),
    sysRedis.packed.get<ModelVersionNameModerationConfig>(KEYS.CONFIG).catch(() => null),
  ]);

  const spec = rawSpec && Array.isArray(rawSpec.triggers) ? rawSpec : EMPTY_SPEC;
  const minScore =
    typeof rawConfig?.minScore === 'number' && rawConfig.minScore > 0 && rawConfig.minScore <= 1
      ? rawConfig.minScore
      : DEFAULT_MIN_SCORE;

  const config = { minScore };
  cache = { spec, config, at: Date.now() };
  return { spec, config };
}

export async function setModelVersionNameTerms(spec: LabelRegexSpec) {
  if (!Array.isArray(spec.triggers)) throw new Error('spec.triggers must be an array');
  await sysRedis.packed.set(KEYS.TERMS, spec);
  cache = null;
}

export async function setModelVersionNameConfig(config: ModelVersionNameModerationConfig) {
  if (!(config.minScore > 0 && config.minScore <= 1))
    throw new Error('minScore must be >0 and <=1');
  await sysRedis.packed.set(KEYS.CONFIG, config);
  cache = null;
}

/** Which curated terms a name matches. Empty means it is not worth an XGuard call. */
export async function matchModelVersionNameTerms(name: string): Promise<string[]> {
  if (!name?.trim()) return [];
  const { spec } = await getModelVersionNameTerms();
  if (!spec.triggers.length) return [];
  const hit = matchSpec('model-version-name-terms', spec, name);
  return hit.matched ? hit.matchedTerms : [];
}
