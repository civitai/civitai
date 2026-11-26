import { describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';

// collection.getAllUser returns only the cover fields its client uses.

const { mockUserCollections } = vi.hoisted(() => ({ mockUserCollections: vi.fn() }));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionsWithPermissions: mockUserCollections,
}));

import { getAllUserCollectionsHandler } from '../collection.controller';

const COVER = {
  id: 7,
  url: 'cover-url',
  type: 'image',
  nsfwLevel: 1,
  ingestion: 'Scanned',
  poi: true,
  minor: true,
  acceptableMinor: true,
  tosViolation: true,
};
const GATE_FLAGS = ['poi', 'minor', 'acceptableMinor', 'tosViolation'];

const call = (input: Record<string, unknown> = {}) =>
  getAllUserCollectionsHandler({
    ctx: { user: { id: 4, isModerator: false } } as never,
    input: { permissions: [], ...input } as never,
  });

describe('getAllUserCollectionsHandler', () => {
  it('returns a cover without the moderation flags', async () => {
    mockUserCollections.mockResolvedValueOnce([
      { id: 1, name: 'c', userId: 5, image: COVER },
      { id: 2, name: 'bare', userId: 5, image: undefined },
    ]);

    const [withCover, bare] = (await call()) as { image?: Record<string, unknown> }[];

    expect(withCover.image).toMatchObject({ id: 7, url: 'cover-url', ingestion: 'Scanned' });
    for (const flag of GATE_FLAGS) expect(withCover.image).not.toHaveProperty(flag);
    expect(bare.image).toBeUndefined();
  });
});
