import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleService from '~/server/services/crucible.service';

const h = vi.hoisted(() => ({ detail: null as unknown }));

vi.mock('~/server/services/crucible.service', async (importOriginal) => {
  const actual = await importOriginal<typeof CrucibleService>();
  return {
    ...actual,
    // As the service does: judged for the viewer on the stored cover.
    getCrucibleDetail: async ({
      userId,
      isModerator,
    }: {
      userId?: number;
      isModerator?: boolean;
    }) =>
      h.detail && {
        ...(h.detail as object),
        hiddenByScan: actual.isCrucibleHiddenByScan(h.detail as never, {
          viewerId: userId,
          isModerator,
        }),
      },
  };
});
vi.mock('~/server/services/crucible-block-lists', () => ({
  getAllBlockedCreatorIds: async () => [],
  getBlockedCreatorIds: async () => [],
}));

const { getCrucibleByIdHandler } = await import('~/server/controllers/crucible.controller');

const OWNER = 4;
const detail = (cover: {
  needsReview: string | null;
  tosViolation: boolean;
  nsfwLevel?: number;
}) => ({
  id: 1,
  userId: OWNER,
  name: 'Night Drive',
  description: null,
  textNsfw: false,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  takenDownAt: null,
  heroImage: null,
  image: { id: 10, url: 'cover', ingestion: 'Scanned', nsfwLevel: 1, ...cover },
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

  it('hides a crucible whose cover is unrated from everyone but its owner and moderators', async () => {
    h.detail = detail({ needsReview: null, tosViolation: false, nsfwLevel: 0 });
    expect(await asViewer(9)).toBeNull();
    expect((await asViewer(OWNER))?.id).toBe(1);
    expect((await asViewer(9, true))?.id).toBe(1);
  });

  it('falls back to the cover when the background image is unrated, except for its owner', async () => {
    const hero = { id: 11, url: 'hero', ingestion: 'Scanned', nsfwLevel: 0 };
    h.detail = { ...detail({ needsReview: null, tosViolation: false }), heroImage: hero };
    expect((await asViewer(9))?.heroImage).toBeNull();
    h.detail = { ...detail({ needsReview: null, tosViolation: false }), heroImage: hero };
    expect((await asViewer(OWNER))?.heroImage).toMatchObject({ id: 11 });
  });

  it('withholds an unrated background image on green too, where adult text is cut', async () => {
    const hero = { id: 11, url: 'hero', ingestion: 'Scanned', nsfwLevel: 0 };
    h.detail = {
      ...detail({ needsReview: null, tosViolation: false }),
      textNsfw: true,
      heroImage: hero,
    };
    const onGreen = await getCrucibleByIdHandler({
      input: { id: 1 },
      ctx: { user: { id: 9, isModerator: false }, features: { isGreen: true } } as never,
    });
    expect(onGreen?.name).toBe('Crucible');
    expect(onGreen?.heroImage).toBeNull();
  });

  it('falls back to the cover when the background image is held for review, except for its owner', async () => {
    const held = { id: 11, url: 'hero', ingestion: 'Scanned', nsfwLevel: 1, needsReview: 'minor' };
    h.detail = { ...detail({ needsReview: null, tosViolation: false }), heroImage: held };
    expect((await asViewer(9))?.heroImage).toBeNull();
    h.detail = { ...detail({ needsReview: null, tosViolation: false }), heroImage: held };
    const own = await asViewer(OWNER);
    expect(own?.heroImage).toMatchObject({ id: 11 });
    expect(own?.heroImage).not.toHaveProperty('needsReview');
  });

  it('serves a scanned, rated background image not held for review (control)', async () => {
    const clean = { id: 11, url: 'hero', ingestion: 'Scanned', nsfwLevel: 1, needsReview: null };
    h.detail = { ...detail({ needsReview: null, tosViolation: false }), heroImage: clean };
    const other = await asViewer(9);
    expect(other?.heroImage).toMatchObject({ id: 11, url: 'hero' });
    expect(other?.heroImage).not.toHaveProperty('needsReview');
  });
});
