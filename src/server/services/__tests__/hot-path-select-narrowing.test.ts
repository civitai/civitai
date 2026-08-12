import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These pin the SELECT SHAPE of read paths that are hot enough for Prisma's
 * client-side row decoding to show up on the main thread: all three `Post`
 * owner lookups in `entity-collaborator.service`, plus the comment-reaction
 * selector.
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
 * The `getReactionsSelect` cases are the deliberate exception, and they do use
 * targeted presence/absence checks. That selector is a module-level object
 * literal rather than a call argument, so it has no "no `select` key at all"
 * shape for an absence-check to pass vacuously on. Its `user` projection is
 * still pinned by exact key set with `toEqual`, and the `not.toHaveProperty`
 * trio beside it is reachable rather than vacuous: deleting `user.select` does
 * not quietly satisfy it, it fails it with `TypeError: Cannot convert undefined
 * or null to object`, and re-adding `profilePicture` fails it by name. The two
 * `toHaveProperty(…, true)` reaction-field checks are presence checks on the
 * top-level selector; like the behavioural cases above they hold on both sides
 * of the narrowing and are not counted as regression coverage.
 *
 * The remaining narrowed path — `hasSystemPosts` in `getAllImages` — is pinned
 * in the sibling file `hot-path-select-narrowing.image.test.ts`. It lives apart
 * because importing `image.service` needs a whole env/redis/submodule mock
 * block, and `vi.mock` is file-scoped.
 */

const postFindUnique = vi.fn();
const entityCollaboratorFindMany = vi.fn();
const entityCollaboratorFindFirst = vi.fn();
const entityCollaboratorCount = vi.fn();
const entityCollaboratorUpsert = vi.fn();
const entityCollaboratorDelete = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    post: {
      findUnique: (...args: unknown[]) => postFindUnique(...args),
    },
    entityCollaborator: {
      findMany: (...args: unknown[]) => entityCollaboratorFindMany(...args),
      findFirst: (...args: unknown[]) => entityCollaboratorFindFirst(...args),
      count: (...args: unknown[]) => entityCollaboratorCount(...args),
    },
  },
  dbWrite: {
    entityCollaborator: {
      upsert: (...args: unknown[]) => entityCollaboratorUpsert(...args),
      delete: (...args: unknown[]) => entityCollaboratorDelete(...args),
    },
  },
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
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { EntityType, EntityCollaboratorStatus } from '~/shared/utils/prisma/enums';

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

describe('getEntityCollaborators — Post owner lookup is projected, not a full row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postFindUnique.mockResolvedValue({ userId: OWNER_ID });
    entityCollaboratorFindMany.mockResolvedValue([]);
  });

  it('asks Postgres for ONLY the owner id', async () => {
    await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: OWNER_ID,
    });

    expect(postFindUnique).toHaveBeenCalledTimes(1);
    const [args] = postFindUnique.mock.calls[0] as [{ select?: Record<string, boolean> }];

    // A bare `findUnique` has no `select` at all — that is the shape this
    // guards against, and it is what shipped before. Asserting the exact key
    // set (rather than just "userId is present") means re-adding `metadata`,
    // `createdAt`, `publishedAt` or `detail` fails here too.
    //
    // This went through the shared helper along with the other two `Post`
    // narrowings when its former companion case — a separate `it` looping over
    // the tagged column names — was deleted. Against a fixed `expected` that
    // case asserted less than this line does, so it could not fail on a SOURCE
    // mutant this one survives; the one edit it did still catch is described on
    // `expectProjection`.
    expectProjection(args, { userId: true }, 'getEntityCollaborators');
  });

  it('still gates pending collaborators on the owner id it fetched', async () => {
    entityCollaboratorFindMany.mockResolvedValue([
      {
        user: { id: COLLABORATOR_ID },
        entityId: POST_ID,
        entityType: EntityType.Post,
        status: EntityCollaboratorStatus.Pending,
      },
    ]);

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

  it('returns [] when the post is missing, without reading further columns', async () => {
    postFindUnique.mockResolvedValue(null);

    const result = await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: OWNER_ID,
    });

    expect(result).toEqual([]);
    expect(entityCollaboratorFindMany).not.toHaveBeenCalled();
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

describe('getReactionsSelect — a reaction names its reactor and nothing more', () => {
  it('selects exactly the two user fields the renderer reads', () => {
    // `ReactionPicker` reads `user.username` (tooltip / "did I react") and its
    // callers read `user.id`. Pinning the exact set is the point: this used to
    // be `simpleUserSelect`, which additionally pulled `deletedAt`, `image`
    // and the whole `profilePicture` relation.
    expect(getReactionsSelect.user.select).toEqual({ id: true, username: true });
  });

  it('does not pull the profilePicture relation (its `metadata` is a non-null Json)', () => {
    const userSelect = getReactionsSelect.user.select as Record<string, unknown>;
    expect(userSelect).not.toHaveProperty('profilePicture');
    expect(userSelect).not.toHaveProperty('deletedAt');
    expect(userSelect).not.toHaveProperty('image');
  });

  it('keeps the reaction fields the grouping and optimistic update depend on', () => {
    expect(getReactionsSelect).toHaveProperty('id', true);
    expect(getReactionsSelect).toHaveProperty('reaction', true);
  });
});
