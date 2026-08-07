import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    collection: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    collectionContributor: { updateMany: vi.fn() },
    collectionInvite: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

const { upsertCollection } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const MANAGER_ID = 777;

function arrange({
  actorId,
  currentWrite = 'Private',
}: {
  actorId: number;
  currentWrite?: 'Public' | 'Review' | 'Private';
}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: currentWrite,
      userId: OWNER_ID,
      type: 'Image',
      mode: null,
      contributorPermissions: actorId === OWNER_ID ? null : ['VIEW', 'ADD', 'MANAGE'],
      collaborationDisabledAt: null,
    },
  ]);
  mockDbWrite.collection.findUnique.mockResolvedValue({
    id: COLLECTION_ID,
    read: 'Public',
    write: currentWrite,
    mode: null,
    createdAt: new Date('2026-01-01'),
    image: null,
  });
  mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      collection: { update: mockDbWrite.collection.update },
      tagsOnCollection: { deleteMany: vi.fn(), createMany: vi.fn() },
    })
  );
  mockDbWrite.collection.update.mockResolvedValue({ id: COLLECTION_ID });
  mockDbWrite.collectionInvite.findMany.mockResolvedValue([]);
}

// The resync writes the POST-update row's grant onto every follower row, so it has to be
// keyed off the PRE-update values; `arrangeDowngrade` sets both sides explicitly.
function arrangeDowngrade({ currentWrite = 'Public' as const, nextWrite = 'Private' as const }) {
  arrange({ actorId: OWNER_ID, currentWrite });
  mockDbWrite.collection.update.mockResolvedValue({
    id: COLLECTION_ID,
    read: 'Public',
    write: nextWrite,
    userId: OWNER_ID,
    mode: null,
    image: null,
  });
}

describe('upsertCollection authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('strips read/write/mode when a non-owner manager submits them', async () => {
    arrange({ actorId: MANAGER_ID });
    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Renamed',
        read: 'Private',
        write: 'Public',
        mode: 'Contest',
        userId: MANAGER_ID,
        isMember: true,
      },
    } as never);

    const updateArgs = mockDbWrite.collection.update.mock.calls[0][0];
    expect(updateArgs.data.name).toBe('Renamed');
    expect(updateArgs.data.read).toBeUndefined();
    expect(updateArgs.data.write).toBeUndefined();
    expect(updateArgs.data.mode).toBeUndefined();
  });

  it('lets the owner change write when they are a member', async () => {
    arrange({ actorId: OWNER_ID });
    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        write: 'Review',
        userId: OWNER_ID,
        isMember: true,
      },
    } as never);

    const updateArgs = mockDbWrite.collection.update.mock.calls[0][0];
    expect(updateArgs.data.write).toBe('Review');
  });

  it('refuses to open submissions for a non-member owner', async () => {
    arrange({ actorId: OWNER_ID });
    await expect(
      upsertCollection({
        input: {
          id: COLLECTION_ID,
          name: 'Mine',
          write: 'Review',
          userId: OWNER_ID,
          isMember: false,
        },
      } as never)
    ).rejects.toThrow();
  });

  it('lets a non-member owner keep an already-open collection', async () => {
    arrange({ actorId: OWNER_ID, currentWrite: 'Review' });
    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Renamed',
        write: 'Review',
        userId: OWNER_ID,
        isMember: false,
      },
    } as never);

    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });

  // I1: the condition compared the requested value with the POST-update row, so it was false
  // exactly when the value changed — followers kept the ADD they were granted while the
  // collection was open, which both let them keep writing and made the whole follower list
  // read as elevated collaborators to getCollaborators.
  it('resyncs follower permissions when write is downgraded Public -> Private', async () => {
    arrangeDowngrade({ currentWrite: 'Public', nextWrite: 'Private' });

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        write: 'Private',
        userId: OWNER_ID,
        isMember: false,
      },
    } as never);

    expect(mockDbWrite.collectionContributor.updateMany).toHaveBeenCalledTimes(1);
    const args = mockDbWrite.collectionContributor.updateMany.mock.calls[0][0];
    expect(args.data.permissions).toEqual(['VIEW']);
    expect(args.where.userId.notIn).toContain(OWNER_ID);
  });

  it('leaves seated collaborators out of the resync, Accepted or still-Pending', async () => {
    arrangeDowngrade({ currentWrite: 'Public', nextWrite: 'Private' });
    mockDbWrite.collectionInvite.findMany.mockResolvedValue([{ userId: MANAGER_ID }]);

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        write: 'Private',
        userId: OWNER_ID,
        isMember: false,
      },
    } as never);

    const args = mockDbWrite.collectionContributor.updateMany.mock.calls[0][0];
    expect(args.where.userId.notIn).toEqual(expect.arrayContaining([OWNER_ID, MANAGER_ID]));
    // Same seat definition the caps and the roster use — a re-invited collaborator's invite is
    // flipped back to Pending, and must stay protected for that window.
    const inviteQuery = mockDbWrite.collectionInvite.findMany.mock.calls[0][0];
    expect(inviteQuery.where.OR).toEqual([
      { status: 'Accepted' },
      { status: 'Pending', createdAt: { gte: expect.any(Date) } },
    ]);
  });

  // The resync has never run in production, so the stored rows assume it never will: rows
  // granted by anything other than following (the contest-manager join URL, historical staff
  // rows) must be untouchable by it. Matching the OLD free grant exactly is what guarantees
  // that — a granted row holds something the free grant never contained.
  it('only re-derives rows that are exactly the previous free grant', async () => {
    arrangeDowngrade({ currentWrite: 'Public', nextWrite: 'Private' });

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        write: 'Private',
        userId: OWNER_ID,
        isMember: false,
      },
    } as never);

    const { where, data } = mockDbWrite.collectionContributor.updateMany.mock.calls[0][0];
    expect(where.permissions).toEqual({ equals: ['VIEW', 'ADD'] });

    // Apply the clause to the row shapes that actually exist on the dev clone.
    const matches = (row: { userId: number; permissions: string[] }) =>
      !where.userId.notIn.includes(row.userId) &&
      row.permissions.length === where.permissions.equals.length &&
      row.permissions.every((p, i) => p === where.permissions.equals[i]);

    expect(matches({ userId: 1, permissions: ['VIEW', 'ADD'] })).toBe(true); // plain follower
    expect(matches({ userId: 2, permissions: ['VIEW', 'ADD', 'MANAGE'] })).toBe(false); // staff/judge
    expect(matches({ userId: 3, permissions: ['ADD', 'MANAGE', 'VIEW'] })).toBe(false); // join-as-manager
    expect(data.permissions).toEqual(['VIEW']);
  });

  it('does not resync when neither read nor write changed', async () => {
    arrangeDowngrade({ currentWrite: 'Public', nextWrite: 'Public' });

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Renamed',
        write: 'Public',
        userId: OWNER_ID,
        isMember: true,
      },
    } as never);

    expect(mockDbWrite.collectionContributor.updateMany).not.toHaveBeenCalled();
  });

  it('lets a non-member owner close their collection', async () => {
    arrange({ actorId: OWNER_ID, currentWrite: 'Review' });
    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        write: 'Private',
        userId: OWNER_ID,
        isMember: false,
      },
    } as never);

    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });
});
