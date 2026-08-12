import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
import { AUTO_FEATURE_NOTE_PREFIX } from '~/server/common/auto-feature';

// Saving an item to a collection sends the item's whole desired membership, so collections it is ALREADY
// in ride along in the payload. Those are no-op upserts — re-running the contest gates on them fails the
// save to an UNRELATED collection whenever an existing entry sits in a closed contest. Reported by a
// creator whose models were in the Krea 2 event collection: adding one to their own collection 400'd with
// "Collection is not accepting submissions at this time".

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: {
    collection: { findMany: vi.fn() },
    collectionItem: { findMany: vi.fn(), count: vi.fn() },
    challenge: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    model: { findMany: vi.fn() },
    modelVersion: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  mockDbWrite: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    collectionItem: { deleteMany: vi.fn(), updateMany: vi.fn() },
    collectionContributor: { upsert: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: vi.fn(),
}));

const { saveItemInCollections } = await import('~/server/services/collection.service');

const USER_ID = 4944;
const MODEL_ID = 2819030;
const CLOSED_CONTEST_ID = 17362940;
const CONTEST_TAG_ID = 3922;
const OWN_COLLECTION_ID = 17567140;

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const collectionRow = (over: Record<string, unknown>) => ({
  id: 0,
  name: 'Collection',
  userId: USER_ID,
  type: 'Model',
  mode: null,
  read: 'Public',
  write: 'Private',
  metadata: {},
  tags: [],
  ...over,
});

function arrange({ alreadyInContest }: { alreadyInContest: boolean }) {
  vi.clearAllMocks();

  mockDbRead.collection.findMany.mockResolvedValue([
    collectionRow({
      id: CLOSED_CONTEST_ID,
      name: 'Krea 2 Event',
      userId: 12042163,
      mode: 'Contest',
      // The window closed yesterday — this is what validateContestCollectionEntry rejects on.
      metadata: { submissionEndDate: YESTERDAY },
      tags: [{ tag: { id: CONTEST_TAG_ID, name: 'krea' }, filterableOnly: false }],
    }),
    collectionRow({ id: OWN_COLLECTION_ID, name: 'My collection' }),
  ]);

  // The item is already an entry in the contest with the same tag; only the own-collection row is new.
  mockDbRead.collectionItem.findMany.mockResolvedValue(
    alreadyInContest ? [{ collectionId: CLOSED_CONTEST_ID, tagId: CONTEST_TAG_ID }] : []
  );
  mockDbRead.collectionItem.count.mockResolvedValue(0);
  mockDbRead.challenge.findFirst.mockResolvedValue(null);
  mockDbRead.user.findUnique.mockResolvedValue({ id: USER_ID, meta: {} });
  mockDbRead.model.findMany.mockResolvedValue([{ id: MODEL_ID, userId: USER_ID }]);
  mockDbRead.modelVersion.findMany.mockResolvedValue([]);

  // getUserCollectionPermissionsByIds — owner of both, so no contributor write is attempted.
  mockDbRead.$queryRaw.mockResolvedValue([
    { id: CLOSED_CONTEST_ID, userId: USER_ID, write: 'Private', read: 'Public', type: 'Model' },
    { id: OWN_COLLECTION_ID, userId: USER_ID, write: 'Private', read: 'Public', type: 'Model' },
  ]);

  mockDbWrite.$executeRaw.mockReturnValue('insert' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);
}

const save = () =>
  saveItemInCollections({
    input: {
      modelId: MODEL_ID,
      type: 'Model',
      userId: USER_ID,
      collections: [
        { collectionId: CLOSED_CONTEST_ID, tagId: CONTEST_TAG_ID },
        { collectionId: OWN_COLLECTION_ID },
      ],
      removeFromCollectionIds: [],
    },
  } as never);

// The remove path reads the same item lookup and permission batch as the add path. Its authorization rule
// (only the item's author, the collection owner, or a manager may remove) has to survive that sharing.
// Whatever id the attribution account happens to have in this database.
const AUTO_FEATURE_USER_ID = 987_654;

const removeFrom = ({
  addedById,
  note = null,
  collectionOwnerId = 999,
}: {
  addedById: number;
  note?: string | null;
  collectionOwnerId?: number;
}) => {
  mockDbRead.collection.findMany.mockResolvedValue([]);
  mockDbRead.user.findFirst.mockResolvedValue({ id: AUTO_FEATURE_USER_ID });
  mockDbRead.collectionItem.findMany.mockResolvedValue([
    { id: 555, collectionId: OWN_COLLECTION_ID, tagId: null, addedById, note },
  ]);
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: OWN_COLLECTION_ID,
      userId: collectionOwnerId,
      write: 'Public',
      read: 'Public',
      type: 'Model',
    },
  ]);
  mockDbWrite.collectionItem.deleteMany.mockReturnValue('delete' as never);
  mockDbWrite.collectionItem.updateMany.mockReturnValue('update' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);

  return saveItemInCollections({
    input: {
      modelId: MODEL_ID,
      type: 'Model',
      userId: USER_ID,
      collections: [],
      removeFromCollectionIds: [OWN_COLLECTION_ID],
    },
  } as never);
};

// Submitting to someone else's collection follows it. That follow is a side effect of the entry landing,
// so a save that writes nothing must not leave the user following anything.
const OTHER_COLLECTION_ID = 55501;
const saveToOthersCollection = ({ write }: { write: 'Public' | 'Private' }) => {
  mockDbRead.collection.findMany.mockResolvedValue([
    collectionRow({ id: OTHER_COLLECTION_ID, userId: 999, write }),
  ]);
  mockDbRead.collectionItem.findMany.mockResolvedValue([]);
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: OTHER_COLLECTION_ID,
      userId: 999,
      write,
      read: 'Public',
      type: 'Model',
      mode: null,
      contributorPermissions: null,
    },
  ]);
  mockDbWrite.$executeRaw.mockReturnValue('insert' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);

  return saveItemInCollections({
    input: {
      modelId: MODEL_ID,
      type: 'Model',
      userId: USER_ID,
      collections: [{ collectionId: OTHER_COLLECTION_ID }],
      removeFromCollectionIds: [],
    },
  } as never);
};

describe('saveItemInCollections follow-on-submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('follows the collection once the entry is written', async () => {
    await expect(saveToOthersCollection({ write: 'Public' })).resolves.toBeDefined();
    expect(mockDbWrite.collectionContributor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_collectionId: { userId: USER_ID, collectionId: OTHER_COLLECTION_ID } },
      })
    );
  });

  it('does not follow a collection the save could not write to', async () => {
    // read:Public grants `follow`, so the follow itself is permitted — but nothing was submitted, and
    // following a collection the user never managed to post to is not what they asked for.
    await expect(saveToOthersCollection({ write: 'Private' })).rejects.toThrow(
      /no changes were made/i
    );
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });
});

describe('saveItemInCollections removals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes an item the caller added', async () => {
    await expect(removeFrom({ addedById: USER_ID })).resolves.toBeDefined();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [555] } },
    });
  });

  it('refuses to remove someone else’s item from a collection the caller does not own', async () => {
    // write:Public grants everyone the right to ADD; it is not a licence to delete another user's entry.
    await expect(removeFrom({ addedById: 4242 })).rejects.toThrow(/no changes were made/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
  });

  // This modal is the other door into removal. The auto-feature job's dedupe is "does a row
  // already exist", so a delete here would hand the image back on the next run — the row has to
  // survive as a rejection, exactly as it does through removeCollectionItem.
  it('rejects an auto-featured item rather than deleting it', async () => {
    await expect(
      removeFrom({
        addedById: AUTO_FEATURE_USER_ID,
        note: `${AUTO_FEATURE_NOTE_PREFIX}:1234`,
        // Featured Images is system-owned, so only a manager reaches this path at all.
        collectionOwnerId: USER_ID,
      })
    ).resolves.toBeDefined();

    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [555] } },
        data: expect.objectContaining({ status: 'REJECTED', reviewedById: USER_ID }),
      })
    );
  });

  // Attribution alone must not tombstone. CivitaiOfficial also curates by hand, and those adds
  // carry no auto-feature note — tombstoning them would make them unremovable for good, since
  // re-adding a rejected row only updates its tag.
  it('deletes a CivitaiOfficial item that the job did not add', async () => {
    await expect(
      removeFrom({
        addedById: AUTO_FEATURE_USER_ID,
        note: 'contest entry',
        collectionOwnerId: USER_ID,
      })
    ).resolves.toBeDefined();

    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [555] } },
    });
  });
});

describe('saveItemInCollections with an existing closed-contest membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves to an unrelated collection without re-validating the closed contest', async () => {
    arrange({ alreadyInContest: true });

    await expect(save()).resolves.toBeDefined();
    expect(mockDbWrite.$transaction).toHaveBeenCalled();
  });

  it('still rejects a NEW entry into the closed contest', async () => {
    arrange({ alreadyInContest: false });

    await expect(save()).rejects.toThrow(/not accepting submissions/i);
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });
});
