import { MODEL_PERMISSION_LOG_START } from '@civitai/shared/merge-permission';
import type { CommercialUse } from '~/shared/utils/prisma/enums';

export type ModelPermissions = {
  allowNoCredit: boolean;
  allowCommercialUse: CommercialUse[];
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
};

export type PermissionSnapshotRow = ModelPermissions & {
  modelId: number;
  effectiveAt?: Date;
  source: 'live' | 'baseline';
  actorUserId: number | null;
  actorRole: string | null;
};

const sameUses = (a: CommercialUse[], b: CommercialUse[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

const applyChange = (
  before: ModelPermissions,
  data: Partial<ModelPermissions>
): ModelPermissions => ({
  allowNoCredit: data.allowNoCredit ?? before.allowNoCredit,
  allowCommercialUse: data.allowCommercialUse ?? before.allowCommercialUse,
  allowDerivatives: data.allowDerivatives ?? before.allowDerivatives,
  allowDifferentLicense: data.allowDifferentLicense ?? before.allowDifferentLicense,
});

export const writesPermissions = (data: Partial<ModelPermissions>) =>
  data.allowNoCredit !== undefined ||
  data.allowCommercialUse !== undefined ||
  data.allowDerivatives !== undefined ||
  data.allowDifferentLicense !== undefined;

export function permissionsChanged(before: ModelPermissions, data: Partial<ModelPermissions>) {
  const after = applyChange(before, data);
  return (
    after.allowNoCredit !== before.allowNoCredit ||
    after.allowDerivatives !== before.allowDerivatives ||
    after.allowDifferentLicense !== before.allowDifferentLicense ||
    !sameUses(after.allowCommercialUse, before.allowCommercialUse)
  );
}

/**
 * Rows to write when a save changes a model's permissions: none if nothing changed, otherwise the
 * new state. A model's first recorded change also writes the state it is leaving, dated to the
 * start of what is known about it, so the period before the change is not lost.
 */
export function buildPermissionSnapshots({
  modelId,
  modelCreatedAt,
  before,
  data,
  hasSnapshots,
  actorUserId,
  actorRole,
}: {
  modelId: number;
  modelCreatedAt: Date;
  before: ModelPermissions;
  data: Partial<ModelPermissions>;
  hasSnapshots: boolean;
  actorUserId: number;
  actorRole: string;
}): PermissionSnapshotRow[] {
  if (!permissionsChanged(before, data)) return [];
  const after = applyChange(before, data);

  const live: PermissionSnapshotRow = {
    modelId,
    source: 'live',
    actorUserId,
    actorRole,
    ...after,
  };
  if (hasSnapshots) return [live];

  const baseline: PermissionSnapshotRow = {
    modelId,
    effectiveAt: new Date(Math.max(MODEL_PERMISSION_LOG_START.getTime(), modelCreatedAt.getTime())),
    source: 'baseline',
    actorUserId: null,
    actorRole: null,
    allowNoCredit: before.allowNoCredit,
    allowCommercialUse: before.allowCommercialUse,
    allowDerivatives: before.allowDerivatives,
    allowDifferentLicense: before.allowDifferentLicense,
  };
  return [baseline, live];
}

export type PermissionChangeEvent = {
  createdAt: Date;
  field: keyof ModelPermissions;
  oldValue: string;
  newValue: string;
  userId: number | null;
  actorRole: string | null;
};

export type BackfillSnapshotRow = ModelPermissions & {
  modelId: number;
  effectiveAt: Date;
  source: 'baseline' | 'backfill';
  actorUserId: number | null;
  actorRole: string | null;
};

// entityChangeEvents stores each value as JSON: `true`, `false`, `["Image","Rent"]`.
const parseValue = (field: keyof ModelPermissions, value: string) => {
  const parsed: unknown = JSON.parse(value);
  if (field === 'allowCommercialUse') {
    if (!Array.isArray(parsed)) throw new Error(`allowCommercialUse is not an array: ${value}`);
    return parsed as CommercialUse[];
  }
  if (typeof parsed !== 'boolean') throw new Error(`${field} is not a boolean: ${value}`);
  return parsed;
};

/**
 * A model's permission history rebuilt from the ClickHouse change log: a baseline holding the state
 * before its first logged change, then one row per save that changed something.
 *
 * `stateAtEnd` is the state once every event has applied. A field with no event never changed in
 * the window, so it takes that value throughout.
 */
export function reconstructPermissionSnapshots({
  modelId,
  modelCreatedAt,
  events,
  stateAtEnd,
}: {
  modelId: number;
  modelCreatedAt: Date;
  events: PermissionChangeEvent[];
  stateAtEnd: ModelPermissions;
}): BackfillSnapshotRow[] {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const state = { ...stateAtEnd } as Record<keyof ModelPermissions, unknown>;
  for (const field of Object.keys(stateAtEnd) as (keyof ModelPermissions)[]) {
    const first = sorted.find((e) => e.field === field);
    if (first) state[field] = parseValue(field, first.oldValue);
  }

  const rows: BackfillSnapshotRow[] = [
    {
      modelId,
      effectiveAt: new Date(
        Math.max(MODEL_PERMISSION_LOG_START.getTime(), modelCreatedAt.getTime())
      ),
      source: 'baseline',
      actorUserId: null,
      actorRole: null,
      ...(state as ModelPermissions),
    },
  ];

  // One save logs one row per changed field, all with the same timestamp: one snapshot per save.
  for (let i = 0; i < sorted.length; ) {
    const at = sorted[i].createdAt.getTime();
    const save = [];
    while (i < sorted.length && sorted[i].createdAt.getTime() === at) save.push(sorted[i++]);
    for (const e of save) state[e.field] = parseValue(e.field, e.newValue);
    rows.push({
      modelId,
      effectiveAt: save[0].createdAt,
      source: 'backfill',
      actorUserId: save[0].userId,
      actorRole: save[0].actorRole,
      ...(state as ModelPermissions),
    });
  }
  return rows;
}

/**
 * A model's permissions at the backfill cutover: today's, except a field changed since, whose first
 * later change records in its oldValue what it held at the cutover.
 */
export function stateAtCutover(
  current: ModelPermissions,
  eventsAfterCutover: PermissionChangeEvent[]
): ModelPermissions {
  const state = {
    allowNoCredit: current.allowNoCredit,
    allowCommercialUse: current.allowCommercialUse,
    allowDerivatives: current.allowDerivatives,
    allowDifferentLicense: current.allowDifferentLicense,
  } as Record<keyof ModelPermissions, unknown>;
  const sorted = [...eventsAfterCutover].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
  for (const field of Object.keys(state) as (keyof ModelPermissions)[]) {
    const first = sorted.find((e) => e.field === field);
    if (first) state[field] = parseValue(field, first.oldValue);
  }
  return state as ModelPermissions;
}
