import { LOCAL_OVERRIDE_SEGMENT, type FliptVariantDetail } from '@civitai/flipt';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptEvalCacheTtlMs,
  getFliptStateVersion,
  getFliptVariantDetailSync,
  isFliptSync,
} from '~/server/flipt/client';
import { L1_CACHE_BYTE_BUDGETS } from '~/server/redis/l1-cache-budget';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import { createCachedFlagGate } from '~/server/utils/cached-flag-gate';
import { createLruCache } from '~/server/utils/lru-cache';
import {
  EXPERIMENT_PIN_SEGMENT_PREFIX,
  experimentKeys,
  experiments,
  isExperimentVariant,
  parseExperimentOverrides,
  type ExperimentAssignment,
  type ExperimentAssignments,
  type ExperimentKey,
} from '~/shared/constants/experiments.constants';
import type { SessionUser } from '~/types/session';

const warnedInvalid = new Set<string>();

export function resolveExperimentAssignment(
  key: ExperimentKey,
  detail: FliptVariantDetail | null
): ExperimentAssignment {
  const { defaultVariant, fliptKey } = experiments[key];
  if (!detail) return { variant: defaultVariant, assignment: 'unavailable' };
  if (!detail.match) return { variant: defaultVariant, assignment: 'off' };
  if (!isExperimentVariant(key, detail.variantKey)) {
    if (!warnedInvalid.has(fliptKey)) {
      warnedInvalid.add(fliptKey);
      console.warn(`[experiments] ${fliptKey} returned unknown variant "${detail.variantKey}"`);
    }
    return { variant: defaultVariant, assignment: 'invalid' };
  }
  if (detail.segmentKeys.includes(LOCAL_OVERRIDE_SEGMENT)) {
    return { variant: detail.variantKey, assignment: 'override' };
  }
  if (detail.segmentKeys.some((s) => s.startsWith(EXPERIMENT_PIN_SEGMENT_PREFIX))) {
    return { variant: detail.variantKey, assignment: 'pinned' };
  }
  return { variant: detail.variantKey, assignment: 'rule' };
}

export async function getExperimentAssignments({
  user,
  overrideCookie,
}: {
  user: SessionUser;
  overrideCookie?: string;
}): Promise<ExperimentAssignments> {
  await ensureFliptInitialized();
  // Both: bucketing hashes the entity id, while every pin and tester segment matches context.
  const entityId = String(user.id);
  const context = buildFliptContext(user);
  // Moderators can carry a preview cookie, so their answer is never memoized.
  if (!user.isModerator && isAssignmentsCacheOn()) {
    return getMemoizedAssignments(entityId, context);
  }
  const overrides = user.isModerator ? parseExperimentOverrides(overrideCookie) : {};
  return computeAssignments(entityId, context, overrides);
}

function computeAssignments(
  entityId: string,
  context: Record<string, string>,
  overrides: ReturnType<typeof parseExperimentOverrides>
): ExperimentAssignments {
  const out = {} as ExperimentAssignments;
  for (const key of experimentKeys) {
    const override = overrides[key];
    out[key] = override
      ? { variant: override, assignment: 'override' }
      : resolveExperimentAssignment(
          key,
          getFliptVariantDetailSync(experiments[key].fliptKey, entityId, context)
        );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-user memo, behind `experiments-assignments-cache` (default OFF).
//
// An assignment is a pure function of (user id, Flipt context, flag state): `computeAssignments`
// reads nothing else for a non-moderator. So an entry is keyed on the user id and the whole
// context, and belongs to one `getFliptStateVersion()` value: a flag edit moves the version and
// drops every entry, which is the only thing that changes an assignment. The client already
// fetches once per tab (`staleTime: Infinity` in `useExperiment`), so this saves the evaluations
// of a repeat load (a reload, a second tab) within the TTL, not a per-navigation call.
//
// Same rule as the feature-flags version cache: the Flipt eval cache can answer with pre-move
// evaluations for up to `getFliptEvalCacheTtlMs()` after a move, so nothing computed in that
// window is kept. Nor is an answer with an `unavailable` arm (Flipt not ready, an unknown key):
// it is transient, and the next call should evaluate again.
export const EXPERIMENT_ASSIGNMENTS_MEMO_TTL_MS = 60_000;
const EXPERIMENT_ASSIGNMENTS_MEMO_MAX = 20_000;

let isAssignmentsCacheOn = createCachedFlagGate(() =>
  isFliptSync(FLIPT_FEATURE_FLAGS.EXPERIMENTS_ASSIGNMENTS_CACHE)
);

const memoEntries = createLruCache<string, ExperimentAssignments>({
  name: 'experiment-assignments',
  max: EXPERIMENT_ASSIGNMENTS_MEMO_MAX,
  maxSize: L1_CACHE_BYTE_BUDGETS.experimentAssignments,
  ttl: EXPERIMENT_ASSIGNMENTS_MEMO_TTL_MS,
  keyFn: (key) => key,
  fetchFn: () => Promise.reject(new Error('experiment-assignments memo is get/set only')),
});
/** The state version the entries belong to, and when this memo first read it (never earlier). */
let memoVersion: { version: number; seenAt: number } | null = null;

/** The memo key: the entity id and every context entry, sorted and encoded so none can alias. */
export function experimentAssignmentsMemoKey(entityId: string, context: Record<string, string>) {
  const ctx = Object.keys(context)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(context[k])}`)
    .join('&');
  return `${encodeURIComponent(entityId)}|${ctx}`;
}

function getMemoizedAssignments(
  entityId: string,
  context: Record<string, string>
): ExperimentAssignments {
  const now = Date.now();
  const version = getFliptStateVersion();
  if (!memoVersion || memoVersion.version !== version) {
    memoEntries.clear();
    memoVersion = { version, seenAt: now };
  }
  const key = experimentAssignmentsMemoKey(entityId, context);
  const hit = memoEntries.get(key);
  // A copy per caller: the tRPC response must never share the memo's objects.
  if (hit) return copyAssignments(hit);

  const out = computeAssignments(entityId, context, {});
  const settled = now - memoVersion.seenAt >= readEvalCacheTtlMs();
  const complete = experimentKeys.every((k) => out[k].assignment !== 'unavailable');
  if (settled && complete) memoEntries.set(key, copyAssignments(out));
  return out;
}

function readEvalCacheTtlMs(): number {
  const ttl = getFliptEvalCacheTtlMs();
  // Unknown reads as the package default, never as 0 (0 would treat every entry as settled).
  return typeof ttl === 'number' && ttl >= 0 ? ttl : 10_000;
}

function copyAssignments(a: ExperimentAssignments): ExperimentAssignments {
  const out = {} as ExperimentAssignments;
  for (const key of Object.keys(a) as (keyof ExperimentAssignments)[]) out[key] = { ...a[key] };
  return out;
}

/** Tests only: forget the cached flag read and every memo entry. */
export function resetExperimentAssignmentsMemoForTests() {
  memoEntries.clear();
  memoVersion = null;
  isAssignmentsCacheOn = createCachedFlagGate(() =>
    isFliptSync(FLIPT_FEATURE_FLAGS.EXPERIMENTS_ASSIGNMENTS_CACHE)
  );
}
