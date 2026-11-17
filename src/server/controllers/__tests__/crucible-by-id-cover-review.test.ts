import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleService from '~/server/services/crucible.service';

const h = vi.hoisted(() => ({ detail: null as unknown }));

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  getCrucibleDetail: async () => h.detail,
}));
vi.mock('~/server/services/crucible-block-lists', () => ({
  getAllBlockedCreatorIds: async () => [],
  getBlockedCreatorIds: async () => [],
}));

const { getCrucibleByIdHandler } = await import('~/server/controllers/crucible.controller');

const OWNER = 4;
const detail = (cover: { needsReview: string | null; tosViolation: boolean }) => ({
  id: 1,
  userId: OWNER,
  name: 'Night Drive',
  description: null,
  textNsfw: false,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  takenDownAt: null,
  heroImage: null,
  image: { id: 10, url: 'cover', ingestion: 'Scanned', ...cover },
});
const asViewer = (id: number, isModerator = false) =>
  getCrucibleByIdHandler({
    input: { id: 1 },
    ctx: { user: { id, isModerator }, features: {} } as never,
  });

beforeEach(() => {
  h.detail = null;
});

describe('getCrucibleByIdHandler and the cover review fields', () => {
  it('hides a crucible whose cover is in review or a ToS violation from everyone else', async () => {
    h.detail = detail({ needsReview: 'minor', tosViolation: false });
    expect(await asViewer(9)).toBeNull();
    h.detail = detail({ needsReview: null, tosViolation: true });
    expect(await asViewer(9)).toBeNull();
  });

  it('never sends the cover review fields to the client, even to its owner', async () => {
    h.detail = detail({ needsReview: 'minor', tosViolation: true });
    const own = await asViewer(OWNER);
    expect(own?.image).toMatchObject({ id: 10, url: 'cover' });
    expect(own?.image).not.toHaveProperty('needsReview');
    expect(own?.image).not.toHaveProperty('tosViolation');

    h.detail = detail({ needsReview: null, tosViolation: false });
    const other = await asViewer(9);
    expect(other?.image).toMatchObject({ id: 10, url: 'cover' });
    expect(other?.image).not.toHaveProperty('needsReview');
  });
});
