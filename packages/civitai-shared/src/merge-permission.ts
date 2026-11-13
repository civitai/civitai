/**
 * Judging a merge by the source model's permission in effect when the merge was made, not by
 * today's. Shared by the main app (report form, snapshot writes) and the moderator app (verdicts).
 */

/**
 * Earliest moment a model's permission state is known: the first whole day of the ClickHouse
 * entity-change log, which began writing Model rows (permissions included) at 2026-07-29 19:50 UTC and
 * is backfilled into ModelPermissionSnapshot. Its first permission change is 2026-07-30 16:06 UTC.
 */
export const MODEL_PERMISSION_LOG_START = new Date('2026-07-30T00:00:00.000Z');

/** The AdminAttention reason a reporter picks for "this merge uses my model against its terms". */
export const MERGE_PERMISSION_REPORT_REASON = 'Merges my model against its permissions';

/** A model id from a bare id or any civitai model URL (`/models/123`, `/models/123/slug?...`). */
export function parseSourceModelId(input: unknown): number | undefined {
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 ? input : undefined;
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  const match = /^\d+$/.test(value) ? value : /\/models\/(\d+)(?:[/?#]|$)/.exec(value)?.[1];
  const id = match ? Number(match) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export type PermissionSnapshotLike = { effectiveAt: Date; allowDerivatives: boolean };

export type MergePermissionVerdict =
  | { status: 'allowed' | 'not-allowed'; knownSince: Date }
  | { status: 'unknown'; knownSince: Date; reason: 'before-log' | 'before-source-existed' };

/**
 * Whether merges of the source model were allowed at `at`.
 *
 * Each snapshot holds the state from its `effectiveAt` until the next one. Nothing is known before
 * the first snapshot. A model with no snapshots has held `current` since it was created or the log
 * began, whichever is later.
 */
export function mergePermissionAt({
  at,
  snapshots,
  current,
  sourceCreatedAt,
}: {
  at: Date;
  snapshots: PermissionSnapshotLike[];
  current: { allowDerivatives: boolean };
  sourceCreatedAt: Date;
}): MergePermissionVerdict {
  const sorted = [...snapshots].sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
  const knownSince = sorted.length
    ? sorted[0].effectiveAt
    : new Date(Math.max(MODEL_PERMISSION_LOG_START.getTime(), sourceCreatedAt.getTime()));

  if (at < knownSince)
    return {
      status: 'unknown',
      knownSince,
      reason: at < sourceCreatedAt ? 'before-source-existed' : 'before-log',
    };

  const inEffect = sorted.filter((s) => s.effectiveAt <= at).at(-1) ?? current;
  return { status: inEffect.allowDerivatives ? 'allowed' : 'not-allowed', knownSince };
}
