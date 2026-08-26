import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { matchSpec, type LabelRegexSpec } from '~/server/services/scanner-label-regex';

/**
 * The curated term list that decides whether a model version's NAME is NSFW.
 *
 * The list DECIDES and XGuard REVIEWS — that order, because XGuard evaluates a two-word title
 * poorly: measured over 2,000 random version names it returns `suggestive` between 0.55 and 0.69
 * for contentless strings like `v1.0`, clearing its own 0.50 threshold. A short name gives it
 * almost nothing to read. The term list catches the worst offenders, and the scan that follows is
 * there to find the list's false positives — over the first full sweep it overturned 24 of 2,620
 * matches and was right in every one.
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

/** Empty means "no terms configured", which selects nothing — the safe failure for this path. */
const EMPTY_SPEC: LabelRegexSpec = { triggers: [] };

/**
 * Cached in-process for a minute. This is read on every version save, and the list changes at
 * human speed. A minute bounds how long a pulled term keeps firing.
 */
let cache: { spec: LabelRegexSpec; at: number } | null = null;
const TTL_MS = 60_000;

export function __clearModelVersionNameTermsCache() {
  cache = null;
}

export async function getModelVersionNameTerms(): Promise<LabelRegexSpec> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.spec;

  // Fails to EMPTY, not to a committed fallback: an unreachable Redis must scan nothing rather
  // than silently fall back to a list nobody can see or edit.
  const raw = await sysRedis.packed.get<LabelRegexSpec>(KEYS.TERMS).catch(() => null);
  const spec = raw && Array.isArray(raw.triggers) ? raw : EMPTY_SPEC;

  cache = { spec, at: Date.now() };
  return spec;
}

export async function setModelVersionNameTerms(spec: LabelRegexSpec) {
  if (!Array.isArray(spec.triggers)) throw new Error('spec.triggers must be an array');
  await sysRedis.packed.set(KEYS.TERMS, spec);
  cache = null;
}

/** Which curated terms a name matches. Empty means the name is not NSFW by this list. */
export async function matchModelVersionNameTerms(name: string): Promise<string[]> {
  if (!name?.trim()) return [];
  const spec = await getModelVersionNameTerms();
  if (!spec.triggers.length) return [];
  const hit = matchSpec('model-version-name-terms', spec, name);
  return hit.matched ? hit.matchedTerms : [];
}
