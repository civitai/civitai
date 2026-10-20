import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateEntityFiles } from '~/server/services/file.service';

const ENTRY = 55;
const OWN_FILE = 1;
const OTHER_ITEMS_FILE = 2;

const URL = 'https://storage.example.com/default/8/lora.safetensors';
const CHECKED = { sha256Server: 'F'.repeat(64), hashCheckedAt: '2026-10-20T00:00:00Z' };
const rows = [
  {
    id: OWN_FILE,
    entityId: ENTRY,
    entityType: 'BountyEntry',
    url: URL,
    metadata: { ...CHECKED, blockedReason: 'other-users-model', unlockAmount: 5 },
  },
  { id: OTHER_ITEMS_FILE, entityId: 99, entityType: 'BountyEntry', url: URL, metadata: {} },
];
const tx = {
  file: {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { id: { in: number[] }; entityId: number; entityType: string };
      }) =>
        rows.filter(
          (r) =>
            where.id.in.includes(r.id) &&
            r.entityId === where.entityId &&
            r.entityType === where.entityType
        )
    ),
    updateMany: vi.fn(
      async ({ where }: { where: { id: number; entityId?: number; entityType?: string } }) => ({
        count: rows.filter(
          (r) =>
            r.id === where.id &&
            (where.entityId === undefined || r.entityId === where.entityId) &&
            (where.entityType === undefined || r.entityType === where.entityType)
        ).length,
      })
    ),
    update: vi.fn(),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
  },
};

const file = (id?: number) => ({
  ...(id && { id }),
  name: 'lora.safetensors',
  url: URL,
  sizeKB: 10,
});

const save = (files: (ReturnType<typeof file> & { metadata?: Record<string, unknown> })[]) =>
  updateEntityFiles({
    tx: tx as never,
    entityId: ENTRY,
    entityType: 'BountyEntry',
    files,
    ownRights: true,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateEntityFiles', () => {
  it("updates the item's own file in place, scoped to the item", async () => {
    await save([file(OWN_FILE)]);

    expect(tx.file.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OWN_FILE, entityId: ENTRY, entityType: 'BountyEntry' },
      })
    );
    expect(tx.file.update).not.toHaveBeenCalled();
  });

  it('refuses a file id that belongs to another item, and removes and adds nothing', async () => {
    await expect(save([file(OWN_FILE), file(OTHER_ITEMS_FILE), file()])).rejects.toThrowError(
      'A file to update is not part of this item.'
    );
    expect(tx.file.deleteMany).not.toHaveBeenCalled();
    expect(tx.file.createMany).not.toHaveBeenCalled();
  });

  it('adds a file sent without an id to the item', async () => {
    await save([file()]);

    expect(tx.file.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ entityId: ENTRY, entityType: 'BountyEntry' })],
    });
  });
});

describe('updateEntityFiles: the file check result', () => {
  const FORGED = {
    sha256Server: '0'.repeat(64),
    hashCheckedAt: 'x',
    hashAttemptedAt: 'x',
    blockedReason: '',
  };
  const savedMetadata = () => tx.file.updateMany.mock.calls[0][0].data.metadata;

  it('is not taken from a caller on a new file', async () => {
    await save([{ ...file(), metadata: { ...FORGED, unlockAmount: 5 } }]);

    expect(tx.file.createMany.mock.calls[0][0].data[0].metadata).toEqual({
      unlockAmount: 5,
      ownRights: true,
    });
  });

  it('is kept when a file is saved again at the same url, whatever the caller sends', async () => {
    await save([{ ...file(OWN_FILE), metadata: { ...FORGED, unlockAmount: 7 } }]);

    expect(savedMetadata()).toEqual({
      ...CHECKED,
      blockedReason: 'other-users-model',
      unlockAmount: 7,
      ownRights: true,
    });
  });

  it('is dropped when the file gets a new url, so it is checked again', async () => {
    await save([
      { ...file(OWN_FILE), url: 'https://storage.example.com/default/8/other.safetensors' },
    ]);

    expect(savedMetadata()).toEqual({ ownRights: true });
  });
});
