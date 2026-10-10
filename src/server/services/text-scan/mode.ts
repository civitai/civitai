import { createHash } from 'crypto';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import type { TextScanEntityType, TextScanMode } from '~/server/services/text-scan/types';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export const TEXT_SCAN_ENTITY_TYPES = [
  'Model',
  'Article',
  'Post',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'ChatMessage',
  'Comment',
  'CommentV2',
  'ResourceReview',
  'User',
  'UserProfile',
  'Crucible',
  'Collection',
  'ModelRules',
] as const satisfies readonly TextScanEntityType[];

/**
 * Per entity type, the percentage of entity ids in each mode. An id's bucket (0–99) is fixed, so
 * raising a percentage only adds ids. `active` is checked first: `{ shadow: 100, active: 10 }` is
 * 10% active and the other 90% shadow.
 */
export type TextScanRollout = { shadow: number; active: number };
export type TextScanRollouts = Partial<Record<TextScanEntityType, TextScanRollout>>;

export const ROLLOUT_CACHE_MS = 15_000;

function percent(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.floor(value)))
    : 0;
}

export function parseTextScanRollout(raw: string | null | undefined): TextScanRollout | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof TextScanRollout, unknown>> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return { shadow: percent(parsed.shadow), active: percent(parsed.active) };
  } catch {
    return undefined;
  }
}

/** Uncached read, for writers and the harness; scans go through `getTextScanMode`. */
export async function readTextScanRollouts(): Promise<TextScanRollouts> {
  const raw = await withSysReadDeadline(sysRedis.hGetAll(REDIS_SYS_KEYS.TEXT_SCAN.MODES));
  const rollouts: TextScanRollouts = {};
  for (const entityType of TEXT_SCAN_ENTITY_TYPES) {
    const rollout = parseTextScanRollout(raw?.[entityType]);
    if (rollout) rollouts[entityType] = rollout;
  }
  return rollouts;
}

// Not the default `Date.now` reference, which is captured once and would ignore a faked clock.
const getTextScanRollouts = createTtlMemo(readTextScanRollouts, ROLLOUT_CACHE_MS, () => Date.now());

export function resetTextScanRolloutCache() {
  getTextScanRollouts.clear();
}

export function textScanBucket(entityType: TextScanEntityType, entityId: number) {
  return createHash('sha256').update(`${entityType}:${entityId}`).digest().readUInt32BE(0) % 100;
}

export function modeForBucket(rollout: TextScanRollout | undefined, bucket: number): TextScanMode {
  if (!rollout) return 'off';
  if (bucket < rollout.active) return 'active';
  if (bucket < rollout.shadow) return 'shadow';
  return 'off';
}

/** The Flipt kill switch. Read inside a call: hand-written flipt mocks often omit the enum. */
export async function isTextScanEnabled() {
  try {
    return await isFlipt(FLIPT_FEATURE_FLAGS.TEXT_SCAN);
  } catch {
    return false;
  }
}

export async function getTextScanMode(
  entityType: TextScanEntityType,
  entityId: number
): Promise<TextScanMode> {
  try {
    if (!(await isTextScanEnabled())) return 'off';
    const rollouts = await getTextScanRollouts();
    return modeForBucket(rollouts[entityType], textScanBucket(entityType, entityId));
  } catch {
    return 'off';
  }
}

export const TEXT_SCAN_SHADOW_SUFFIX = ':shadow';

// Shadow verdicts live on their own EntityModeration row. The live row is read by rating
// floors and owned by the pipeline still acting (XGuard for Model/Article/Challenge);
// sharing it would let a shadow verdict raise ratings and clobber the live workflowId.
export function textScanEmEntityType(entityType: TextScanEntityType, mode: 'shadow' | 'active') {
  return mode === 'shadow' ? `${entityType}${TEXT_SCAN_SHADOW_SUFFIX}` : entityType;
}

export function parseTextScanEmEntityType(emEntityType: string) {
  const shadow = emEntityType.endsWith(TEXT_SCAN_SHADOW_SUFFIX);
  return {
    entityType: shadow ? emEntityType.slice(0, -TEXT_SCAN_SHADOW_SUFFIX.length) : emEntityType,
    shadow,
  };
}
