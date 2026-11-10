import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';

/**
 * These pin the SELECT SHAPE of read paths that are hot enough for Prisma's
 * client-side row decoding to show up on the main thread: the two Prisma `Post`
 * owner lookups in `entity-collaborator.service` (the write paths), plus the
 * comment-reaction selector. The read path's owner lookup is one Kysely
 * statement with the collaborator rows; that it stays off the Prisma `Post` row
 * is pinned below, and its SQL in the db-queries package.
 *
 * Prisma walks the engine response in JS and converts every tagged value per
 * row — `DateTime` -> `new Date`, `Json` -> `JSON.parse`, `Decimal` ->
 * `new Decimal`, `BigInt`, `Bytes` -> `Buffer.from`. So a column that is
 * fetched and never read is not free: it is an allocation per row per request.
 *
 * Each shape assertion fails against the pre-narrowing code, and each is paired
 * with a behavioural case so the shape check cannot pass while the logic that
 * consumes the remaining fields is broken. The behavioural cases are invariant
 * guards — they pass on both sides of the narrowing by design, and are not
 * counted as regression coverage.
 *
 * 🔴 Wherever the thing under test is a Prisma call ARGUMENT, the shape is
 * pinned by its EXACT key set with `toEqual`, never "does not contain
 * <column>". That distinction is the whole reason those assertions look the way
 * they do: an unnarrowed `findUnique` has no `select` at all, and
 * `Object.keys(undefined ?? {})` is empty, so an absence-check passes on
 * precisely the shape being rejected. `toEqual` has no such hole — it fails on
 * `undefined` by itself. The two `toBeDefined` lines inside `expectProjection`
 * survive for their FAILURE MESSAGE, not for coverage: they name the real
 * defect ("a bare Prisma call fetches every column") instead of leaving a bare
 * `undefined` mismatch for the reader to decode.
 *
 * The remaining narrowed path — `hasSystemPosts` in `getAllImages` — is pinned
 * in the sibling file `hot-path-select-narrowing.image.test.ts`. It lives apart
 * because importing `image.service` needs a whole env/redis/submodule mock
 * block, and `vi.mock` is file-scoped.
 */

const postFindUnique = dbMock.dbRead.post.findUnique;
const entityCollaboratorFindMany = dbMock.dbRead.entityCollaborator.findMany;
const entityCollaboratorFindFirst = dbMock.dbRead.entityCollaborator.findFirst;
const entityCollaboratorCount = dbMock.dbRead.entityCollaborator.count;
const entityCollaboratorUpsert = dbMock.dbWrite.entityCollaborator.upsert;
const entityCollaboratorDelete = dbMock.dbWrite.entityCollaborator.delete;

// The read path's owner and collaborator rows, one Kysely statement. Its rows, against a real
// database, are pinned in hot-reads-5.kysely-parity.test.ts.
const { listPostCollaborators } = vi.hoisted(() => ({ listPostCollaborators: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  listPostCollaborators,
}));

// Reached transitively by the service under test; instantiating the real chat
// stack here would pull in Redis. Nothing below exercises messaging.
vi.mock('~/server/services/chat.service', () => ({
  createMessage: vi.fn(),
  upsertChat: vi.fn(),
}));

import {
  getEntityCollaborators,
  removeEntityCollaborator,
  upsertEntityCollaborator,
} from '~/server/services/entity-collaborator.service';
import { EntityType, EntityCollaboratorStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { kyselyRead } from '~/server/db/kyselyDb';

const OWNER_ID = 101;
const COLLABORATOR_ID = 202;
const STRANGER_ID = 303;
const POST_ID = 5150;
const TARGET_USER_ID = 404;

/**
 * Asserts a Prisma call argument carries a projection, and that the projection
 * is exactly `expected`.
 *
 * `toEqual` on the exact key set is the entire shape guard. Re-adding any of
 * the `Post` columns that cost a client-side decode per row — `metadata`,
 * `createdAt`, `updatedAt`, `publishedAt` — fails it, as does dropping to a
 * bare call with no `select`. An earlier revision also looped over those four
 * column names asserting each was absent. Given a FIXED `expected`, that loop
 * was redundant: it sat AFTER the `toEqual`, and any select containing one of
 * those columns had already failed there. It was not redundant in every
 * scenario, though — it also went red when `expected` was widened ALONGSIDE the
 * source (the ordinary "developer updates the failing expectation" edit),
 * naming the re-added column, and a `toEqual` against a widened `expected` by
 * construction cannot catch that. Removing the loop accepts the loss of that
 * narrow ratchet against a test-file edit.
 *
 * The two `toBeDefined` lines are for the failure message only — see the file
 * header.
 */
function expectProjection(
  args: { select?: Record<string, boolean> } | undefined,
  expected: Record<string, boolean>,
  label: string
) {
  expect(args, `${label}: the query was never issued`).toBeDefined();
  expect(
    args?.select,
    `${label}: no \`select\` — a bare Prisma call fetches every column`
  ).toBeDefined();
  expect(args?.select).toEqual(expected);
}

describe('getEntityCollaborators — the Post owner comes with the collaborators, off the Post row', () => {
  /** The statement's rows: the owner on each, the collaborator columns null for none. */
  const collaboratorRow = (collaboratorUserId: number | null, status: string | null = null) => ({
    postUserId: OWNER_ID,
    collaboratorUserId,
    entityId: collaboratorUserId === null ? null : POST_ID,
    entityType: collaboratorUserId === null ? null : EntityType.Post,
    status,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listPostCollaborators.mockResolvedValue([collaboratorRow(null)]);
  });

  it('reads the owner id in the one Kysely statement, never the Post row through Prisma', async () => {
    await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: OWNER_ID,
    });

    expect(listPostCollaborators.mock.calls).toEqual([[kyselyRead, POST_ID]]);
    expect(listPostCollaborators.mock.calls[0][0]).toBe(kyselyRead);
    expect(postFindUnique).not.toHaveBeenCalled();
    expect(entityCollaboratorFindMany).not.toHaveBeenCalled();
  });

  it('still gates pending collaborators on the owner id it fetched', async () => {
    listPostCollaborators.mockResolvedValue([
      collaboratorRow(COLLABORATOR_ID, EntityCollaboratorStatus.Pending),
    ]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: COLLABORATOR_ID }]);

    const asOwner = await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: OWNER_ID,
    });
    expect(asOwner).toHaveLength(1);

    const asStranger = await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: STRANGER_ID,
    });
    expect(asStranger).toHaveLength(0);
  });

  it('returns [] when the post is missing, without reading any user', async () => {
    listPostCollaborators.mockResolvedValue([]);

    const result = await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: OWNER_ID,
    });

    expect(result).toEqual([]);
    expect(dbMock.dbRead.user.findMany).not.toHaveBeenCalled();
  });
});

/**
 * `upsertEntityCollaborator` and `removeEntityCollaborator` do the SAME
 * full-row-for-one-field lookup that `getEntityCollaborators` did, in the same
 * file. They are ratcheted here for the same reason: each is one careless
 * `findUnique({ where })` away from regrowing, and nothing else in the suite
 * would notice.
 */
describe('upsertEntityCollaborator — Post owner lookup is projected, not a full row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postFindUnique.mockResolvedValue({ userId: OWNER_ID });
    entityCollaboratorFindFirst.mockResolvedValue(null);
    entityCollaboratorCount.mockResolvedValue(0);
    entityCollaboratorUpsert.mockResolvedValue({ id: 1 });
  });

  it('asks Postgres for ONLY the owner id', async () => {
    await upsertEntityCollaborator({
      entityId: POST_ID,
      entityType: EntityType.Post,
      targetUserId: TARGET_USER_ID,
      userId: OWNER_ID,
    } as Parameters<typeof upsertEntityCollaborator>[0]);

    expect(postFindUnique).toHaveBeenCalledTimes(1);
    const [args] = postFindUnique.mock.calls[0] as [{ select?: Record<string, boolean> }];
    expectProjection(args, { userId: true }, 'upsertEntityCollaborator');
  });

  it('still refuses a non-owner using the owner id it fetched', async () => {
    // Behavioural pair for the shape check above: proves the surviving field is
    // the one the authorization branch actually consults, so the projection
    // cannot be narrowed to something the logic no longer reads.
    await expect(
      upsertEntityCollaborator({
        entityId: POST_ID,
        entityType: EntityType.Post,
        targetUserId: TARGET_USER_ID,
        userId: STRANGER_ID,
      } as Parameters<typeof upsertEntityCollaborator>[0])
    ).rejects.toThrow(/Only the owner of the post can add collaborators/);

    expect(entityCollaboratorUpsert).not.toHaveBeenCalled();

    // …and the owner still gets through.
    await expect(
      upsertEntityCollaborator({
        entityId: POST_ID,
        entityType: EntityType.Post,
        targetUserId: TARGET_USER_ID,
        userId: OWNER_ID,
      } as Parameters<typeof upsertEntityCollaborator>[0])
    ).resolves.toBeTruthy();
    expect(entityCollaboratorUpsert).toHaveBeenCalledTimes(1);
  });
});

describe('removeEntityCollaborator — Post owner lookup is projected, not a full row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postFindUnique.mockResolvedValue({ userId: OWNER_ID });
    entityCollaboratorFindFirst.mockResolvedValue({ id: 1, userId: TARGET_USER_ID });
    entityCollaboratorDelete.mockResolvedValue({ id: 1 });
  });

  it('asks Postgres for ONLY the owner id', async () => {
    await removeEntityCollaborator({
      entityId: POST_ID,
      entityType: EntityType.Post,
      targetUserId: TARGET_USER_ID,
      userId: OWNER_ID,
    } as Parameters<typeof removeEntityCollaborator>[0]);

    expect(postFindUnique).toHaveBeenCalledTimes(1);
    const [args] = postFindUnique.mock.calls[0] as [{ select?: Record<string, boolean> }];
    expectProjection(args, { userId: true }, 'removeEntityCollaborator');
  });

  it('still refuses a non-owner using the owner id it fetched', async () => {
    await expect(
      removeEntityCollaborator({
        entityId: POST_ID,
        entityType: EntityType.Post,
        targetUserId: TARGET_USER_ID,
        userId: STRANGER_ID,
      } as Parameters<typeof removeEntityCollaborator>[0])
    ).rejects.toThrow(/Only the owner of the post can remove collaborators/);

    expect(entityCollaboratorDelete).not.toHaveBeenCalled();

    await expect(
      removeEntityCollaborator({
        entityId: POST_ID,
        entityType: EntityType.Post,
        targetUserId: TARGET_USER_ID,
        userId: OWNER_ID,
      } as Parameters<typeof removeEntityCollaborator>[0])
    ).resolves.toBe(true);
    expect(entityCollaboratorDelete).toHaveBeenCalledTimes(1);
  });
});
