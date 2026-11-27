import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * A collection becomes a profile folder only through createFolder, and a folder's storage is fixed:
 * mode Folder, no type, private write, Unsearchable. The client's upsert input cannot make a folder
 * or turn a collection into one.
 */

const { upsertCollection, createFolder } = await import('~/server/services/collection.service');

const OWNER = 5;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.collection.create.mockResolvedValue({
    id: 1,
    image: null,
    name: 'n',
    description: null,
    read: 'Public',
    write: 'Private',
    availability: 'Unsearchable',
    userId: OWNER,
    mode: 'Folder',
  } as never);
});

const createData = () =>
  (dbMock.dbWrite.collection.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('creating a folder', () => {
  it("refuses mode Folder from the client's collection input", async () => {
    await expect(
      upsertCollection({
        input: { userId: OWNER, name: 'n', type: 'Model', mode: 'Folder' } as never,
      })
    ).rejects.toThrow(/created from your profile/);
    expect(dbMock.dbWrite.collection.create).not.toHaveBeenCalled();
  });

  it('stores a folder untyped, private-write and unsearchable, whatever the input says', async () => {
    await upsertCollection({
      input: {
        userId: OWNER,
        name: 'n',
        type: 'Image',
        write: 'Public',
        read: 'Unlisted',
        asFolder: true,
      } as never,
    });
    expect(createData()).toMatchObject({
      mode: 'Folder',
      type: null,
      write: 'Private',
      availability: 'Unsearchable',
      read: 'Unlisted',
    });
  });
});

describe('editing', () => {
  beforeEach(() => {
    // getUserCollectionPermissionsById: the caller owns and manages a plain collection.
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      {
        id: 20,
        read: 'Public',
        write: 'Private',
        userId: OWNER,
        type: null,
        mode: null,
        contributorPermissions: ['MANAGE', 'ADD', 'VIEW'],
        collaborationDisabledAt: null,
      },
    ] as never);
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({
      id: 20,
      name: 'n',
      description: null,
      read: 'Public',
      write: 'Private',
      availability: 'Public',
      mode: null,
      metadata: {},
      userId: OWNER,
      image: null,
    } as never);
  });

  it('refuses turning a collection into a folder', async () => {
    await expect(
      upsertCollection({
        input: { id: 20, userId: OWNER, name: 'n', type: 'Model', mode: 'Folder' } as never,
      })
    ).rejects.toThrow(/created from your profile/);
    expect(dbMock.dbWrite.collection.update).not.toHaveBeenCalled();
  });
});

describe('createFolder', () => {
  const create = () => createFolder({ userId: OWNER, name: 'n', read: 'Public' });

  it('creates a folder while the owner is under the cap', async () => {
    dbMock.dbWrite.collection.count.mockResolvedValue(99 as never);
    await create();
    expect(createData()).toMatchObject({ mode: 'Folder', userId: OWNER });
  });

  it('refuses the 101st folder and creates nothing', async () => {
    dbMock.dbWrite.collection.count.mockResolvedValue(100 as never);
    await expect(create()).rejects.toThrow(/up to 100 folders/);
    expect(dbMock.dbWrite.collection.create).not.toHaveBeenCalled();
  });

  it('refuses, creating nothing, while another create for the same owner holds the lock', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(redisMock.redis.set).mockResolvedValue(null as never);
      const pending = create();
      const outcome = expect(pending).rejects.toThrow(/still being created/);
      await vi.runAllTimersAsync();
      await outcome;
      expect(dbMock.dbWrite.collection.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
