import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const { mockCountCacheRefresh } = vi.hoisted(() => ({
  mockCountCacheRefresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

// `upsertCollection` refreshes the collection-count cache once the transaction commits, and that
// talks to redis. Unmocked it resolves on a machine with a local redis and blocks to the suite
// timeout on one without — so this passed for anyone running it by hand and failed only in CI,
// as eight identical 60s timeouts carrying no assertion.
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  userCollectionCountCache: { refresh: mockCountCacheRefresh },
}));

vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanSubmit>()),
  scanEntityInBackground: vi.fn(),
}));

vi.mock('~/server/services/job-queue.service', () => ({
  enqueueJobs: vi.fn(async () => undefined),
}));

const { upsertCollection } = await import('~/server/services/collection.service');
const { enqueueJobs } = await import('~/server/services/job-queue.service');
const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');

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

  it('scans a Private collection made Public after the transaction commits', async () => {
    arrange({ actorId: OWNER_ID });
    const current = { name: 'Mine', description: null, availability: 'Public' };
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      read: 'Private',
      write: 'Private',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: null,
      ...current,
    });
    mockDbWrite.collection.update.mockResolvedValue({
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Private',
      userId: OWNER_ID,
      mode: null,
      image: null,
      ...current,
    });
    let committed = false;
    mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const result = await fn({
        collection: { update: mockDbWrite.collection.update },
        tagsOnCollection: { deleteMany: vi.fn(), createMany: vi.fn() },
      });
      committed = true;
      return result;
    });
    let committedAtScan: boolean | undefined;
    let committedAtEnqueue: boolean | undefined;
    vi.mocked(scanEntityInBackground).mockImplementation(() => {
      committedAtScan = committed;
    });
    vi.mocked(enqueueJobs).mockImplementation(async () => {
      committedAtEnqueue = committed;
    });

    await upsertCollection({
      input: { id: COLLECTION_ID, name: 'Mine', read: 'Public', userId: OWNER_ID, isMember: true },
    } as never);

    expect(committedAtScan).toBe(true);
    expect(committedAtEnqueue).toBe(true);

    expect(scanEntityInBackground).toHaveBeenCalledWith({
      entityType: 'Collection',
      entityId: COLLECTION_ID,
    });
    // Queued, not run inline: the recompute can time out on a huge collection.
    expect(enqueueJobs).toHaveBeenCalledWith([
      { entityType: 'Collection', entityId: COLLECTION_ID, type: 'UpdateNsfwLevel' },
    ]);
  });

  it('saves a Private → Public flip even when queueing the recompute fails', async () => {
    arrange({ actorId: OWNER_ID });
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      name: 'Mine',
      description: null,
      read: 'Private',
      write: 'Private',
      availability: 'Public',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: null,
    });
    mockDbWrite.collection.update.mockResolvedValue({
      id: COLLECTION_ID,
      name: 'Mine',
      description: null,
      read: 'Public',
      write: 'Private',
      availability: 'Public',
      userId: OWNER_ID,
      mode: null,
      image: null,
    });
    vi.mocked(enqueueJobs).mockRejectedValueOnce(new Error('db down'));

    await expect(
      upsertCollection({
        input: {
          id: COLLECTION_ID,
          name: 'Mine',
          read: 'Public',
          userId: OWNER_ID,
          isMember: true,
        },
      } as never)
    ).resolves.toMatchObject({ id: COLLECTION_ID });
    expect(scanEntityInBackground).toHaveBeenCalled();
  });

  it('scans a text edit of a visible collection without queueing a recompute', async () => {
    arrange({ actorId: OWNER_ID, currentWrite: 'Public' });
    const visible = { description: null, read: 'Public', availability: 'Public' };
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      name: 'Mine',
      write: 'Public',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: null,
      ...visible,
    });
    mockDbWrite.collection.update.mockResolvedValue({
      id: COLLECTION_ID,
      name: 'Renamed',
      write: 'Public',
      userId: OWNER_ID,
      mode: null,
      image: null,
      ...visible,
    });

    await upsertCollection({
      input: { id: COLLECTION_ID, name: 'Renamed', userId: OWNER_ID, isMember: true },
    } as never);

    expect(scanEntityInBackground).toHaveBeenCalledWith({
      entityType: 'Collection',
      entityId: COLLECTION_ID,
    });
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it('does not scan an edit that leaves text and visibility alone', async () => {
    arrange({ actorId: OWNER_ID, currentWrite: 'Public' });
    const row = { name: 'Mine', description: null, read: 'Public', availability: 'Public' };
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      write: 'Public',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: null,
      ...row,
    });
    mockDbWrite.collection.update.mockResolvedValue({
      id: COLLECTION_ID,
      write: 'Public',
      userId: OWNER_ID,
      mode: null,
      image: null,
      ...row,
    });
    await upsertCollection({
      input: { id: COLLECTION_ID, write: 'Public', userId: OWNER_ID, isMember: true },
    } as never);

    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  // The pin reads the stored blob off the primary row `upsertCollection` loads for the update.
  const storedMetadata = (metadata: Record<string, unknown>) =>
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Private',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: null,
      metadata,
    } as never);
  const writtenMetadata = () => mockDbWrite.collection.update.mock.calls[0][0].data.metadata;

  it('pins forcedBrowsingLevel to the stored value for a non-moderator', async () => {
    arrange({ actorId: OWNER_ID });
    storedMetadata({ forcedBrowsingLevel: 1 });

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        metadata: { forcedBrowsingLevel: 31 },
        userId: OWNER_ID,
        isMember: true,
      },
    } as never);

    expect(writtenMetadata().forcedBrowsingLevel).toBe(1);
  });

  it('keeps the stored forcedBrowsingLevel and autoTagId when a non-moderator sends no metadata', async () => {
    arrange({ actorId: MANAGER_ID });
    storedMetadata({ forcedBrowsingLevel: 1, autoTagId: 5 });

    await upsertCollection({
      input: { id: COLLECTION_ID, name: 'Renamed', userId: MANAGER_ID, isMember: true },
    } as never);

    expect(writtenMetadata()).toEqual({ forcedBrowsingLevel: 1, autoTagId: 5 });
    expect(mockDbRead.collection.findUnique).not.toHaveBeenCalled();
  });

  it('drops forcedBrowsingLevel from a non-moderator when none is stored', async () => {
    arrange({ actorId: OWNER_ID });
    storedMetadata({});

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        metadata: { forcedBrowsingLevel: 31 },
        userId: OWNER_ID,
        isMember: true,
      },
    } as never);

    expect(writtenMetadata()).not.toHaveProperty('forcedBrowsingLevel');
  });

  it('drops forcedBrowsingLevel from a non-moderator creating a collection', async () => {
    mockDbWrite.collection.create.mockResolvedValue({
      id: COLLECTION_ID,
      name: 'New',
      description: null,
      read: 'Private',
      availability: 'Public',
      userId: OWNER_ID,
    } as never);

    await upsertCollection({
      input: {
        name: 'New',
        read: 'Private',
        type: 'Image',
        metadata: { forcedBrowsingLevel: 31 },
        userId: OWNER_ID,
        isMember: true,
      },
    } as never);

    const createArgs = mockDbWrite.collection.create.mock.calls[0][0];
    expect(createArgs.data.metadata).not.toHaveProperty('forcedBrowsingLevel');
  });

  it('lets a moderator change forcedBrowsingLevel', async () => {
    arrange({ actorId: MANAGER_ID });
    storedMetadata({ forcedBrowsingLevel: 1 });

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        metadata: { forcedBrowsingLevel: 31 },
        userId: MANAGER_ID,
        isModerator: true,
        isMember: true,
      },
    } as never);

    expect(writtenMetadata().forcedBrowsingLevel).toBe(31);
  });

  it('lets a moderator clear forcedBrowsingLevel', async () => {
    arrange({ actorId: MANAGER_ID });
    storedMetadata({ forcedBrowsingLevel: 1 });

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Mine',
        metadata: {},
        userId: MANAGER_ID,
        isModerator: true,
        isMember: true,
      },
    } as never);

    expect(writtenMetadata()).not.toHaveProperty('forcedBrowsingLevel');
  });
});

describe('upsertCollection create-path scan', () => {
  beforeEach(() => vi.clearAllMocks());

  const created = (read: 'Public' | 'Private') => ({
    id: COLLECTION_ID,
    name: 'New',
    description: null,
    read,
    write: 'Private',
    availability: 'Public',
    userId: OWNER_ID,
    mode: null,
    image: null,
  });

  it('scans a new public collection', async () => {
    mockDbWrite.collection.create.mockResolvedValue(created('Public') as never);

    await upsertCollection({
      input: { name: 'New', read: 'Public', type: 'Image', userId: OWNER_ID, isMember: true },
    } as never);

    expect(scanEntityInBackground).toHaveBeenCalledWith({
      entityType: 'Collection',
      entityId: COLLECTION_ID,
    });
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it('does not scan a new private collection', async () => {
    mockDbWrite.collection.create.mockResolvedValue(created('Private') as never);

    await upsertCollection({
      input: { name: 'New', read: 'Private', type: 'Image', userId: OWNER_ID, isMember: true },
    } as never);

    expect(mockDbWrite.collection.create).toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it('does not scan a Public → Private edit', async () => {
    arrange({ actorId: OWNER_ID });
    const row = { name: 'Mine', description: null, availability: 'Public' };
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Private',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: null,
      ...row,
    });
    mockDbWrite.collection.update.mockResolvedValue({
      id: COLLECTION_ID,
      read: 'Private',
      write: 'Private',
      userId: OWNER_ID,
      mode: null,
      image: null,
      ...row,
    });

    await upsertCollection({
      input: { id: COLLECTION_ID, name: 'Mine', read: 'Private', userId: OWNER_ID, isMember: true },
    } as never);

    expect(mockDbWrite.collection.update).toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
    expect(enqueueJobs).not.toHaveBeenCalled();
  });
});

describe('upsertCollection cover image', () => {
  beforeEach(() => vi.clearAllMocks());

  const COVER_KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';
  const EXISTING_IMAGE = 4_321;

  const save = (image: Record<string, unknown>, actorId = MANAGER_ID) =>
    upsertCollection({
      input: { id: COLLECTION_ID, name: 'Covered', image, userId: actorId, isMember: true },
    } as never);

  const OTHER_USER = 31_337;
  const imageOwnedBy = (userId: number | null) =>
    mockDbWrite.image.findUnique.mockResolvedValue(userId === null ? null : { userId });
  const acceptedItem = (found: boolean) =>
    mockDbWrite.collectionItem.findFirst.mockResolvedValue(found ? { id: 1 } : null);

  it('refuses an existing image the caller neither owns nor has as an accepted item', async () => {
    arrange({ actorId: MANAGER_ID });
    imageOwnedBy(OTHER_USER);
    acceptedItem(false);

    await expect(save({ id: EXISTING_IMAGE, url: COVER_KEY, type: 'image' })).rejects.toThrow(
      /invalid cover image/i
    );

    expect(mockDbWrite.collectionItem.findFirst).toHaveBeenCalledWith({
      where: { imageId: EXISTING_IMAGE, collectionId: COLLECTION_ID, status: 'ACCEPTED' },
      select: { id: true },
    });
    expect(mockDbWrite.collection.update).not.toHaveBeenCalled();
  });

  it('accepts an accepted item of the collection that someone else owns', async () => {
    arrange({ actorId: MANAGER_ID });
    imageOwnedBy(OTHER_USER);
    acceptedItem(true);

    await save({ id: EXISTING_IMAGE, url: COVER_KEY, type: 'image' });

    const { image } = mockDbWrite.collection.update.mock.calls[0][0].data;
    expect(image.connectOrCreate.where).toEqual({ id: EXISTING_IMAGE });
  });

  it('accepts the caller’s own image without an item lookup', async () => {
    arrange({ actorId: MANAGER_ID });
    imageOwnedBy(MANAGER_ID);
    acceptedItem(false);

    await save({ id: EXISTING_IMAGE, url: COVER_KEY, type: 'image' });

    expect(mockDbWrite.collectionItem.findFirst).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });

  it('refuses a cover given as imageId the same way', async () => {
    arrange({ actorId: MANAGER_ID });
    imageOwnedBy(OTHER_USER);
    acceptedItem(false);

    await expect(
      upsertCollection({
        input: {
          id: COLLECTION_ID,
          name: 'Covered',
          imageId: EXISTING_IMAGE,
          userId: MANAGER_ID,
          isMember: true,
        },
      } as never)
    ).rejects.toThrow(/invalid cover image/i);
  });

  it('lets a moderator use any existing image', async () => {
    arrange({ actorId: MANAGER_ID });
    imageOwnedBy(OTHER_USER);
    acceptedItem(false);

    await upsertCollection({
      input: {
        id: COLLECTION_ID,
        name: 'Covered',
        image: { id: EXISTING_IMAGE, url: COVER_KEY, type: 'image' },
        userId: MANAGER_ID,
        isModerator: true,
        isMember: true,
      },
    } as never);

    expect(mockDbWrite.image.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });

  it('re-saves the current cover without a check', async () => {
    arrange({ actorId: MANAGER_ID });
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Private',
      mode: null,
      createdAt: new Date('2026-01-01'),
      image: { id: EXISTING_IMAGE },
    });

    await save({ id: EXISTING_IMAGE, url: COVER_KEY, type: 'image' });

    expect(mockDbWrite.image.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });

  it('creates a newly uploaded cover without a check', async () => {
    arrange({ actorId: MANAGER_ID });

    await save({ url: COVER_KEY, type: 'image' });

    expect(mockDbWrite.image.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.findFirst).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });
});
