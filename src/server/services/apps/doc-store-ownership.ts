// The `ownedModelVersions` rule of an App Blocks storage collection. The `data` comes from an
// app-rendered page holding the viewer's block token, so the ids are untrusted; the rule comes
// only from the reviewed manifest, so a request cannot opt out of it.
import { dbRead } from '~/server/db/client';
import { INT4_MAX } from '~/server/schema/base.schema';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { DeclaredStorageCollection } from '~/shared/constants/block-storage.constants';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

type Resolved = { found: true; value: unknown } | { found: false };

/**
 * Resolve an RFC 6901 pointer (already validated by the manifest parser) against `data`. A
 * segment that names no own property, an out-of-range or non-canonical array index, or a
 * step into a non-container resolves to nothing.
 */
export function resolveJsonPointer(data: unknown, pointer: string): Resolved {
  let cur: unknown = data;
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!ARRAY_INDEX.test(seg) || Number(seg) >= cur.length) return { found: false };
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object' && cur !== null) {
      if (!Object.hasOwn(cur, seg)) return { found: false };
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

/** The owner of each model version that exists and is not deleted, by version id. */
export type VersionOwnerLookup = (ids: number[]) => Promise<Map<number, number>>;

export const lookupVersionOwners: VersionOwnerLookup = async (ids) => {
  const rows = await dbRead.modelVersion.findMany({
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
 * non-deleted model version whose model belongs to `authorUid` (an anonymous author, `null`,
 * owns nothing). A pointer that resolves to nothing is allowed. At most one database read, and
 * none when no declared field is present.
 */
export async function assertOwnedModelVersions(
  decl: DeclaredStorageCollection,
  data: Record<string, unknown>,
  authorUid: number | null,
  lookup: VersionOwnerLookup = lookupVersionOwners
): Promise<void> {
  const pointers = decl.ownedModelVersions;
  if (!pointers || pointers.length === 0) return;
  const claimed: { pointer: string; id: number }[] = [];
  for (const pointer of pointers) {
    const at = resolveJsonPointer(data, pointer);
    if (!at.found) continue;
    const id = at.value;
    // Out of `integer` range is refused here, never sent to the query (Prisma would throw).
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > INT4_MAX) {
      throw notOwned(pointer);
    }
    claimed.push({ pointer, id });
  }
  if (claimed.length === 0) return;
  const owners = await lookup([...new Set(claimed.map((c) => c.id))]);
  for (const { pointer, id } of claimed) {
    if (owners.get(id) !== authorUid) throw notOwned(pointer);
  }
}
