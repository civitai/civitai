import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateEntityFiles } from '~/server/services/file.service';

// Bounty and bounty-entry saves send their files back with ids; a file is only updated as part of
// the item being saved.

const ENTRY = 55;
const OWN_FILE = 1;
const OTHER_ITEMS_FILE = 2;

const rows = [
  { id: OWN_FILE, entityId: ENTRY, entityType: 'BountyEntry' },
  { id: OTHER_ITEMS_FILE, entityId: 99, entityType: 'BountyEntry' },
];
const tx = {
  file: {
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
  url: 'https://storage.example.com/default/8/lora.safetensors',
  sizeKB: 10,
});

const save = (files: ReturnType<typeof file>[]) =>
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
