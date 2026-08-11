import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These pin the SELECT SHAPE of three read paths that are hot enough for
 * Prisma's client-side row decoding to show up on the main thread.
 *
 * Prisma walks the engine response in JS and converts every tagged value per
 * row — `DateTime` -> `new Date`, `Json` -> `JSON.parse`, `Decimal` ->
 * `new Decimal`, `BigInt`, `Bytes` -> `Buffer.from`. So a column that is
 * fetched and never read is not free: it is an allocation per row per request.
 * Each assertion below fails against the pre-narrowing code, and each is
 * paired with a behavioural case so the shape check cannot pass while the
 * logic that consumes the remaining fields is broken.
 */

const postFindUnique = vi.fn();
const entityCollaboratorFindMany = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    post: {
      findUnique: (...args: unknown[]) => postFindUnique(...args),
    },
    entityCollaborator: {
      findMany: (...args: unknown[]) => entityCollaboratorFindMany(...args),
    },
  },
  dbWrite: {},
}));

// Reached transitively by the service under test; instantiating the real chat
// stack here would pull in Redis. Nothing below exercises messaging.
vi.mock('~/server/services/chat.service', () => ({
  createMessage: vi.fn(),
  upsertChat: vi.fn(),
}));

import { getEntityCollaborators } from '~/server/services/entity-collaborator.service';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { EntityType, EntityCollaboratorStatus } from '~/shared/utils/prisma/enums';

const OWNER_ID = 101;
const COLLABORATOR_ID = 202;
const STRANGER_ID = 303;
const POST_ID = 5150;

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
    expect(args.select).toEqual({ userId: true });
  });

  it('does not select any of the Post columns that cost a decode per row', async () => {
    await getEntityCollaborators({
      entityId: POST_ID,
      entityType: EntityType.Post,
      userId: OWNER_ID,
    });

    const [args] = postFindUnique.mock.calls[0] as [{ select?: Record<string, boolean> }];

    // Assert the projection EXISTS before asserting what is missing from it.
    // Without this line the loop below is vacuous — an absent `select` means
    // Prisma returns every column, yet `Object.keys(undefined ?? {})` is empty
    // and every `not.toContain` passes. That is the shape this whole file is
    // guarding against, so it has to be the first thing checked.
    expect(args.select, 'a bare findUnique fetches every column').toBeDefined();

    const selected = Object.keys(args.select as Record<string, boolean>);
    // Json + DateTime columns on Post — each one is a decode per row.
    for (const tagged of ['metadata', 'createdAt', 'updatedAt', 'publishedAt']) {
      expect(selected).not.toContain(tagged);
    }
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
