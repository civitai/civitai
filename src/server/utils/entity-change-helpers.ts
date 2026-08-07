import { randomUUID } from 'crypto';
import type {
  EntityChangeActorRole,
  EntityChangeRow,
  WatchedEntityType,
} from '~/server/common/entity-change.constants';
import { watchedEntityFields } from '~/server/common/entity-change.constants';

// Protects the ClickHouse insert payload from pathological values (huge
// description HTML). Values beyond the cap are stored truncated + flagged.
const VALUE_CAP = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

// Deterministic encoding so semantically-equal values never produce a
// false-positive change row: object keys are sorted recursively and arrays of
// primitives are sorted (order is meaningless for every watched array field —
// lockedProperties, trainedWords, allowCommercialUse).
export function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(normalizeValue(value));
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeValue);
    const allPrimitive = normalized.every((v) => typeof v !== 'object' || v === null);
    return allPrimitive
      ? [...normalized].sort((a, b) => String(a).localeCompare(String(b)))
      : normalized;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalizeValue(value[key])])
    );
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function capValue(encoded: string): { value: string; truncated: 0 | 1 } {
  if (encoded.length <= VALUE_CAP) return { value: encoded, truncated: 0 };
  return { value: encoded.slice(0, VALUE_CAP), truncated: 1 };
}

// Expand a watched field into (dottedPath, before, after) leaf pairs. Scalars
// and arrays stay as a single leaf; plain objects are diffed per leaf so rows
// stay small and queryable (earlyAccessConfig.chargeForDownload, ...). Depth is
// one level — nested objects below that compare as encoded values.
function* fieldLeaves(
  field: string,
  before: unknown,
  after: unknown
): Generator<{ path: string; before: unknown; after: unknown }> {
  if (isPlainObject(after) || (after === null && isPlainObject(before))) {
    const beforeObj = isPlainObject(before) ? before : {};
    const afterObj = isPlainObject(after) ? after : {};
    const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    for (const key of keys) {
      yield { path: `${field}.${key}`, before: beforeObj[key], after: afterObj[key] };
    }
    return;
  }
  yield { path: field, before, after };
}

export function diffEntityChanges({
  entityType,
  entityId,
  ownerId,
  before,
  after,
  actorRole,
  reason,
  systemFields,
}: {
  entityType: WatchedEntityType;
  entityId: number;
  ownerId: number;
  /** null = creation; Phase 1 logs changes only, so creations emit nothing. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  actorRole: EntityChangeActorRole;
  reason?: string;
  /**
   * Fields whose change was made by an automated rule rather than the actor
   * (e.g. profanity auto-NSFW). Their rows get
   * actorRole='system' + the given reason; the rest of the batch keeps the
   * caller's attribution.
   */
  systemFields?: Partial<Record<string, string>>;
}): EntityChangeRow[] {
  if (!before) return [];

  const rows: EntityChangeRow[] = [];
  const batchId = randomUUID();

  for (const field of watchedEntityFields[entityType]) {
    // Partial updates: a field absent from the payload was not touched.
    if (!(field in after) || after[field] === undefined) continue;

    for (const leaf of fieldLeaves(field, before[field], after[field])) {
      const oldEncoded = stableStringify(leaf.before);
      const newEncoded = stableStringify(leaf.after ?? null);
      if (oldEncoded === newEncoded) continue;

      const oldCapped = capValue(oldEncoded);
      const newCapped = capValue(newEncoded);
      const systemReason = systemFields?.[field];

      rows.push({
        entityType,
        entityId,
        ownerId,
        field: leaf.path,
        oldValue: oldCapped.value,
        newValue: newCapped.value,
        truncated: oldCapped.truncated || newCapped.truncated ? 1 : 0,
        actorRole: systemReason !== undefined ? 'system' : actorRole,
        reason: systemReason ?? reason ?? '',
        batchId,
      });
    }
  }

  return rows;
}

export function resolveActorRole({
  actorUserId,
  ownerId,
  isModerator,
}: {
  actorUserId: number;
  ownerId: number;
  isModerator?: boolean;
}): EntityChangeActorRole {
  return isModerator && actorUserId !== ownerId ? 'moderator' : 'owner';
}
