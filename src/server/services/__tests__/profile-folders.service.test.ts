import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The folder rules that run in Node: who may write a folder and what it may hold, which rows a
 * save may place, and what a visitor sees. The Prisma calls are answered from small in-memory
 * tables that apply the where clauses they are given.
 */

const { assertFolderWriteAllowed, earnsCollectCredit, onlyFolders } = await import(
  '~/server/services/profile-folder-guard'
);
const { setFolderRows, getProfileFolders } = await import(
  '~/server/services/profile-folders.service'
);

const OWNER = 5;
const STRANGER = 6;
type CollectionRow = { id: number; userId: number; mode: string | null; read: string };
let collections: CollectionRow[];
let models: { id: number; userId: number }[];
let folderRows: unknown;

const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && 'in' in condition)
      return (condition as { in: unknown[] }).in.includes(row[key]);
    if (condition && typeof condition === 'object' && 'not' in condition)
      return row[key] !== (condition as { not: unknown }).not;
    return row[key] === condition;
  });

const access = { foldersEnabled: true, session: { muted: false, mutedAt: null } };

beforeEach(() => {
  collections = [
    { id: 10, userId: OWNER, mode: 'Folder', read: 'Public' },
    { id: 11, userId: OWNER, mode: 'Folder', read: 'Private' },
    { id: 12, userId: OWNER, mode: 'Folder', read: 'Public' },
    { id: 20, userId: OWNER, mode: null, read: 'Public' },
    { id: 30, userId: STRANGER, mode: 'Folder', read: 'Public' },
  ];
  models = [
    { id: 1, userId: OWNER },
    { id: 2, userId: STRANGER },
  ];
  folderRows = null;
  const findCollections = async ({ where }: { where: Record<string, unknown> }) =>
    collections
      .filter((c) => matches(c, where))
      .map((c) => ({ ...c, name: `f${c.id}`, description: null }));
  dbMock.dbWrite.collection.findMany.mockImplementation(findCollections as never);
  dbMock.dbRead.collection.findMany.mockImplementation(findCollections as never);
  dbMock.dbWrite.collection.count.mockImplementation(
    (async ({ where }: never) => collections.filter((c) => matches(c, where)).length) as never
  );
  dbMock.dbWrite.model.findMany.mockImplementation((async ({ where }: never) =>
    models.filter((m) => matches(m, where))) as never);
  dbMock.dbRead.userProfile.findUnique.mockImplementation((async () => ({ folderRows })) as never);
  dbMock.dbWrite.userProfile.update.mockImplementation((async ({ data }: never) => {
    folderRows = (data as { folderRows: unknown }).folderRows;
    return {};
  }) as never);
});

describe('assertFolderWriteAllowed', () => {
  const add = (collectionIds: number[], ids: number[], overrides = {}) =>
    assertFolderWriteAllowed({
      collectionIds,
      userId: OWNER,
      access: { ...access, ...overrides },
      items: { type: 'Model', ids },
    });

  it('lets the owner file their own model, and leaves non-folder collections alone', async () => {
    await expect(add([10], [1])).resolves.toBeUndefined();
    // A normal collection takes someone else's model, as before; the folder rules do not apply.
    await expect(add([20], [2], { foldersEnabled: false })).resolves.toBeUndefined();
  });

  it("refuses someone else's model in a folder", async () => {
    await expect(add([10], [2])).rejects.toThrow(/owner's own content/);
    await expect(add([10], [1, 2])).rejects.toThrow(/owner's own content/);
  });

  it('refuses any folder write without the flag, and from a muted account', async () => {
    await expect(add([10], [1], { foldersEnabled: false })).rejects.toThrow(/not available/);
    await expect(assertFolderWriteAllowed({ collectionIds: [10], userId: OWNER })).rejects.toThrow(
      /not available/
    );
    const muted = { ...access, session: { muted: true, mutedAt: null } };
    await expect(
      assertFolderWriteAllowed({ collectionIds: [10], userId: OWNER, access: muted })
    ).rejects.toThrow();
  });

  it('refuses posts and 3D models in a folder', async () => {
    await expect(
      assertFolderWriteAllowed({
        collectionIds: [10],
        userId: OWNER,
        access,
        items: { type: 'Post', ids: [1] },
      })
    ).rejects.toThrow(/models, images and articles/);
  });
});

describe('onlyFolders', () => {
  beforeEach(() => {
    dbMock.dbRead.collection.findMany.mockImplementation((async ({ where }: never) =>
      collections.filter((c) => matches(c, where))) as never);
  });

  it('is true only when every collection is a folder', async () => {
    expect(await onlyFolders([10, 11])).toBe(true);
    expect(await onlyFolders([10, 20])).toBe(false);
    expect(await onlyFolders([20])).toBe(false);
    expect(await onlyFolders([])).toBe(false);
  });
});

describe('earnsCollectCredit', () => {
  it('gives no collect credit for filing into folders only', async () => {
    expect(await earnsCollectCredit({ collectionIds: [10, 11], foldersEnabled: true })).toBe(false);
  });

  it('gives credit when any collection is not a folder, and always without the flag', async () => {
    expect(await earnsCollectCredit({ collectionIds: [10, 20], foldersEnabled: true })).toBe(true);
    expect(await earnsCollectCredit({ collectionIds: [10], foldersEnabled: false })).toBe(true);
  });
});

describe('setFolderRows', () => {
  const row = (folders: number[]) => ({
    id: 'r1',
    name: 'Styles',
    folders: folders.map((id) => ({ id })),
  });

  it("saves rows of the caller's own folders", async () => {
    await setFolderRows({ userId: OWNER, rows: [row([10, 11])] });
    expect(folderRows).toEqual([row([10, 11])]);
  });

  it('refuses a save over rows that changed since the editor opened', async () => {
    dbMock.dbWrite.userProfile.updateMany.mockResolvedValue({ count: 0 } as never);
    await expect(
      setFolderRows({ userId: OWNER, rows: [row([10])], ifUnchangedFrom: [row([11])] })
    ).rejects.toThrow(/changed while saving/);
    expect(dbMock.dbWrite.userProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER, folderRows: { equals: [row([11])] } } })
    );
  });

  it("refuses another user's folder, a plain collection, or a folder in two rows", async () => {
    await expect(setFolderRows({ userId: OWNER, rows: [row([30])] })).rejects.toThrow(
      /own folders/
    );
    await expect(setFolderRows({ userId: OWNER, rows: [row([20])] })).rejects.toThrow(
      /own folders/
    );
    await expect(
      setFolderRows({ userId: OWNER, rows: [row([10]), { ...row([10]), id: 'r2' }] })
    ).rejects.toThrow(/one row only/);
    expect(folderRows).toBeNull();
  });
});

describe('getProfileFolders', () => {
  beforeEach(() => {
    folderRows = [{ id: 'r1', name: 'Styles', folders: [{ id: 10 }, { id: 12, hidden: true }] }];
  });
  // Counts and card items come from SQL, covered in profile-folders.pglite.test.ts.
  const summaries = async (ids: number[]) =>
    new Map(
      ids.map((id) => [
        id,
        {
          counts: { Model: 1, Image: 0, Article: 0, total: 1 },
          preview: [{ type: 'Model' as const, id: 1 }],
        },
      ])
    );
  const folderIds = (result: Awaited<ReturnType<typeof getProfileFolders>>) =>
    result.rows.flatMap((row) => row.folders.map((folder) => folder.id));

  it('shows a visitor public folders that are not hidden', async () => {
    const result = await getProfileFolders({ userId: OWNER, viewerId: STRANGER }, summaries);
    expect(folderIds(result)).toEqual([10]);
    expect(result.rows[0].folders[0].preview).toEqual([{ type: 'Model', id: 1 }]);
  });

  it('shows the owner every folder, unplaced ones in a trailing untitled row', async () => {
    const result = await getProfileFolders({ userId: OWNER, viewerId: OWNER }, summaries);
    expect(folderIds(result)).toEqual([10, 12, 11]);
    expect(result.rows.at(-1)).toMatchObject({ id: null, name: '' });
  });
});
