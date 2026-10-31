import { createHash } from 'crypto';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import type {
  TextScanEntityType,
  TextScanLabel,
  TextScanMode,
} from '~/server/services/text-scan/types';
import {
  TEXT_SCAN_FLAG_LABELS,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
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
  'CommentV3',
  'ResourceReview',
  'User',
  'UserProfile',
  'Crucible',
  'Collection',
  'Storyline',
  'ImageCaption',
  'ModelRules',
] as const satisfies readonly TextScanEntityType[];

/**
 * Per entity type, the percentage of entity ids in each mode. An id's bucket (0–99) is fixed, so
 * raising a percentage only adds ids. `active` is checked first: `{ shadow: 100, active: 10 }` is
 * 10% active and the other 90% shadow.
 */
export type TextScanRollout = { shadow: number; active: number };
export type TextScanRollouts = Partial<Record<TextScanEntityType, TextScanRollout>>;

/**
 * An entity type's rollout. CommentV3 follows CommentV2's until it is given its own: a surface's
 * comments move from one type to the other when its writes flip, and their scanning must not lapse.
 */
export const rolloutFor = (rollouts: TextScanRollouts, entityType: TextScanEntityType) =>
  rollouts[entityType] ?? (entityType === 'CommentV3' ? rollouts.CommentV2 : undefined);

export const ROLLOUT_CACHE_MS = 15_000;

const labelModeErrorLogAt = { flag: 0, csam: 0 };

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
  getTextScanWebSearchRollouts.clear();
  getLabelModeState.clear();
  labelModeErrorLogAt.flag = labelModeErrorLogAt.csam = 0;
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
    return modeForBucket(rolloutFor(rollouts, entityType), textScanBucket(entityType, entityId));
  } catch {
    return 'off';
  }
}

/**
 * A second pass with the orchestrator's web search tool, only for the labels where outside
 * knowledge decides the verdict (is this a real person; how old is this character).
 */
export const TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES = [
  'Model',
] as const satisfies readonly TextScanEntityType[];
export const TEXT_SCAN_WEB_SEARCH_LABELS = [
  'poi',
  'minor',
] as const satisfies readonly TextScanLabel[];
export type TextScanVariant = 'web-search';

export function isTextScanWebSearchEntityType(entityType: string) {
  return (TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES as readonly string[]).includes(entityType);
}

/** Uncached read, for writers and the harness; scans go through `getTextScanWebSearchMode`. */
export async function readTextScanWebSearchRollouts(): Promise<TextScanRollouts> {
  const raw = await withSysReadDeadline(sysRedis.hGetAll(REDIS_SYS_KEYS.TEXT_SCAN.WEB_SEARCH));
  const rollouts: TextScanRollouts = {};
  for (const entityType of TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES) {
    const rollout = parseTextScanRollout(raw?.[entityType]);
    if (rollout) rollouts[entityType] = rollout;
  }
  return rollouts;
}

const getTextScanWebSearchRollouts = createTtlMemo(
  readTextScanWebSearchRollouts,
  ROLLOUT_CACHE_MS,
  () => Date.now()
);

const MODE_ORDER: Record<TextScanMode, number> = { off: 0, shadow: 1, active: 2 };

/** Never above the main mode: the search pass shadows or replaces part of a scan that runs. */
export async function getTextScanWebSearchMode(
  entityType: TextScanEntityType,
  entityId: number,
  mainMode?: TextScanMode
): Promise<TextScanMode> {
  if (!isTextScanWebSearchEntityType(entityType)) return 'off';
  try {
    const main = mainMode ?? (await getTextScanMode(entityType, entityId));
    if (main === 'off' || !(await isTextScanEnabled())) return 'off';
    const rollouts = await getTextScanWebSearchRollouts();
    const search = modeForBucket(rollouts[entityType], textScanBucket(entityType, entityId));
    return MODE_ORDER[search] < MODE_ORDER[main] ? search : main;
  } catch {
    return 'off';
  }
}

/** What a poi/minor detection does once the scan can act: `review` holds it for a moderator. */
export type TextScanLabelMode = 'auto' | 'review';
export type TextScanLabelModes = Partial<Record<TextScanFlagLabel, 'review'>>;

/** Whether the csam label is asked for at all. It has no `auto`: it never acts on its own. */
export type TextScanCsamMode = 'off' | 'review';
export const TEXT_SCAN_CSAM_MODE_FIELD = 'csam';

type LabelModeState = { labels: TextScanLabelModes; csam: TextScanCsamMode };

async function readLabelModeState(): Promise<LabelModeState> {
  const raw = await withSysReadDeadline(sysRedis.hGetAll(REDIS_SYS_KEYS.TEXT_SCAN.LABEL_MODES));
  const labels: TextScanLabelModes = {};
  for (const label of TEXT_SCAN_FLAG_LABELS)
    if (raw?.[label] === 'review') labels[label] = 'review';
  return { labels, csam: raw?.[TEXT_SCAN_CSAM_MODE_FIELD] === 'review' ? 'review' : 'off' };
}

/** Uncached read. Only `review` is stored; anything else reads as `auto`. */
export async function readTextScanLabelModes(): Promise<TextScanLabelModes> {
  return (await readLabelModeState()).labels;
}

/** Uncached read. Only `review` is stored; anything else reads as `off`. */
export async function readTextScanCsamMode(): Promise<TextScanCsamMode> {
  return (await readLabelModeState()).csam;
}

const getLabelModeState = createTtlMemo(readLabelModeState, ROLLOUT_CACHE_MS, () => Date.now());

const LABEL_MODE_ERROR_LOG_MS = 5 * 60_000;

// Every scan retries a failed read, so the log is throttled per process and per gate.
function logLabelModeReadFailure(
  gate: keyof typeof labelModeErrorLogAt,
  { label, message }: { label: string; message: string },
  error: unknown
) {
  const now = Date.now();
  if (now - labelModeErrorLogAt[gate] < LABEL_MODE_ERROR_LOG_MS) return;
  labelModeErrorLogAt[gate] = now;
  try {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message,
      label,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
  } catch {
    // Logging must not undo the fallback.
  }
}

/** A failed read is `auto`: the flag lands as it always did rather than a detection going unheld. */
export async function getTextScanLabelMode(label: TextScanFlagLabel): Promise<TextScanLabelMode> {
  try {
    return (await getLabelModeState()).labels[label] ?? 'auto';
  } catch (error) {
    logLabelModeReadFailure(
      'flag',
      { label, message: 'label mode read failed, falling back to auto' },
      error
    );
    return 'auto';
  }
}

export async function getTextScanCsamMode(): Promise<TextScanCsamMode> {
  try {
    return (await getLabelModeState()).csam;
  } catch (error) {
    // Fail closed: an unreadable gate must not start asking for csam on every entity.
    logLabelModeReadFailure(
      'csam',
      { label: 'csam', message: 'csam mode read failed, falling back to off' },
      error
    );
    return 'off';
  }
}

export const TEXT_SCAN_SHADOW_SUFFIX = ':shadow';
const WEB_SEARCH_ACTIVE_SUFFIX = ':search';
const WEB_SEARCH_SHADOW_SUFFIX = ':search-shadow';

// Shadow verdicts live on their own EntityModeration row. The live row is read by rating
// floors and owned by the pipeline still acting (XGuard for Model/Article/Challenge);
// sharing it would let a shadow verdict raise ratings and clobber the live workflowId.
// The web-search pass gets rows of its own for the same reason, in both modes.
export function textScanEmEntityType(
  entityType: TextScanEntityType,
  mode: 'shadow' | 'active',
  variant?: TextScanVariant
) {
  if (variant === 'web-search')
    return `${entityType}${
      mode === 'shadow' ? WEB_SEARCH_SHADOW_SUFFIX : WEB_SEARCH_ACTIVE_SUFFIX
    }`;
  return mode === 'shadow' ? `${entityType}${TEXT_SCAN_SHADOW_SUFFIX}` : entityType;
}

export function parseTextScanEmEntityType(emEntityType: string): {
  entityType: string;
  shadow: boolean;
  variant?: TextScanVariant;
} {
  for (const [suffix, shadow] of [
    [WEB_SEARCH_SHADOW_SUFFIX, true],
    [WEB_SEARCH_ACTIVE_SUFFIX, false],
  ] as const)
    if (emEntityType.endsWith(suffix))
      return { entityType: emEntityType.slice(0, -suffix.length), shadow, variant: 'web-search' };
  const shadow = emEntityType.endsWith(TEXT_SCAN_SHADOW_SUFFIX);
  return {
    entityType: shadow ? emEntityType.slice(0, -TEXT_SCAN_SHADOW_SUFFIX.length) : emEntityType,
    shadow,
  };
}
