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

  it('leaves accepted collaborators out of the resync', async () => {
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
