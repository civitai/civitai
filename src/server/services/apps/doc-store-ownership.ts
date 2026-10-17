// The `ownedModelVersions` rule of an App Blocks storage collection. The `data` comes from an
// app-rendered page holding the viewer's block token, so the ids are untrusted; the rule comes
// only from the reviewed manifest, so a request cannot opt out of it.
import { getDbWithoutLagBatch } from '~/server/db/db-lag-helpers';
import { INT4_MAX } from '~/server/schema/base.schema';
import { docStoreDependency, DocStoreError } from '~/server/services/apps/doc-store.types';
import type { DeclaredStorageCollection } from '~/shared/constants/block-storage.constants';
import { ModelStatus } from '~/shared/utils/prisma/enums';

type Resolved = { found: true; value: unknown } | { found: false };

/**
 * Resolve a declared pointer (identifier segments only, validated by the manifest parser)
 * against `data`. Each step must be an own property of a plain object; an array, or any
 * other non-object, on the way resolves to nothing.
 */
export function resolveOwnedPointer(data: unknown, pointer: string): Resolved {
  let cur: unknown = data;
  for (const seg of pointer.split('/').slice(1)) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return { found: false };
    if (!Object.hasOwn(cur, seg)) return { found: false };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}

/** The owner of each model version that exists and is not deleted, by version id. */
export type VersionOwnerLookup = (ids: number[]) => Promise<Map<number, number>>;

export const lookupVersionOwners: VersionOwnerLookup = async (ids) => {
  // The primary when any id was written within the replication-lag window, so a version created
  // moments ago is not refused as missing, and one deleted moments ago is not accepted off a
  // replica that still has it. Creation, deletion and an ownership transfer all flag it.
  const db = await getDbWithoutLagBatch('modelVersion', ids);
  const rows = await db.modelVersion.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      model: { select: { userId: true, status: true, deletedAt: true } },
    },
  });
  const owners = new Map<number, number>();
  for (const row of rows) {
    const deleted =
      row.status === ModelStatus.Deleted ||
      row.model.status === ModelStatus.Deleted ||
      row.model.deletedAt !== null;
    if (!deleted) owners.set(row.id, row.model.userId);
  }
  return owners;
};

function notOwned(pointer: string): DocStoreError {
  // One message for every reason — not the writer's, missing, deleted, not an id — so the
  // refusal reveals nothing about whether a version exists.
  return new DocStoreError(
    'resource_not_owned',
    'the model version at this field is not one the author owns',
    { pointer }
  );
}

/**
 * Refuses `data` unless every declared pointer that resolves holds a positive integer id of a
 * non-deleted model version whose model belongs to `authorUid`. A pointer that resolves to
 * nothing is allowed. At most one database read, and none when no declared field is present;
 * a failed read is a retryable 503, never an acceptance.
 */
export async function assertOwnedModelVersions(
  decl: DeclaredStorageCollection,
  data: Record<string, unknown>,
  authorUid: number,
  lookup: VersionOwnerLookup = lookupVersionOwners
): Promise<void> {
  const pointers = decl.ownedModelVersions;
  if (!pointers || pointers.length === 0) return;
  const claimed: { pointer: string; id: number }[] = [];
  for (const pointer of pointers) {
    const at = resolveOwnedPointer(data, pointer);
    if (!at.found) continue;
    const id = at.value;
    // Out of `integer` range is refused here, never sent to the query (Prisma would throw).
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > INT4_MAX) {
      throw notOwned(pointer);
    }
    claimed.push({ pointer, id });
  }
  if (claimed.length === 0) return;
  const owners = await docStoreDependency(lookup([...new Set(claimed.map((c) => c.id))]));
  for (const { pointer, id } of claimed) {
    if (owners.get(id) !== authorUid) throw notOwned(pointer);
  }
}
