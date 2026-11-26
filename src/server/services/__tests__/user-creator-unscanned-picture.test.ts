import { describe, expect, it, vi } from 'vitest';

// The creator card is one cached, edge-cached payload for every viewer, so it carries a profile
// picture only once the picture is Scanned.

const row = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@civitai/db-queries/hot-reads', () => ({
  getUserCreatorRow: vi.fn(async () => row.current),
  getUserStatRow: vi.fn(async () => null),
}));

import { profilePictureOf, readUserCreatorViaKysely } from '~/server/services/user-creator.reads';

const db = { connection: () => ({ execute: (fn: (c: unknown) => unknown) => fn({}) }) } as never;

const creatorRow = (ingestion: string) => ({
  id: 5,
  image: null,
  username: 'creator',
  muted: false,
  bannedAt: null,
  deletedAt: null,
  createdAt: new Date(0),
  publicSettings: null,
  settings: null,
  excludeFromLeaderboards: false,
  flags: 0,
  links: [],
  rankUserId: null,
  cosmetics: [],
  modelCount: 0,
  profilePictureId: 9,
  profilePictureName: null,
  profilePictureUrl: `avatar-${ingestion}`,
  profilePictureNsfwLevel: 1,
  profilePictureHash: null,
  profilePictureUserId: 5,
  profilePictureIngestion: ingestion,
  profilePictureType: 'image',
  profilePictureWidth: null,
  profilePictureHeight: null,
  profilePictureMetadata: null,
  profilePictureNeedsReview: null as string | null,
});

describe('creator card profile picture', () => {
  it.each(['Pending', 'Error'])('carries no %s picture', async (state) => {
    row.current = creatorRow(state);
    const read = await readUserCreatorViaKysely(db, { id: 5 });
    expect(read?.user.profilePicture).toBeNull();
  });

  it.each(['csam', 'minor'])('carries no Scanned picture held %s', async (hold) => {
    row.current = { ...creatorRow('Scanned'), profilePictureNeedsReview: hold };
    const read = await readUserCreatorViaKysely(db, { id: 5 });
    expect(read?.user.profilePicture).toBeNull();
  });

  it.each(['csam', 'minor'])(
    'the profile read drops a picture held %s for every viewer, its owner included',
    (hold) => {
      // `profilePictureOf` also builds the profile read's picture (hot-reads-9), whose owner branch
      // otherwise serves the owner their own unscanned picture.
      const held = { ...creatorRow('Scanned'), profilePictureNeedsReview: hold };
      expect(profilePictureOf(held as never)).toBeNull();
      expect(profilePictureOf(creatorRow('Pending') as never)?.url).toBe('avatar-Pending');
      const otherReview = { ...creatorRow('Scanned'), profilePictureNeedsReview: 'poi' };
      expect(profilePictureOf(otherReview as never)?.url).toBe('avatar-Scanned');
    }
  );

  it.each([
    ['csam', 'https://cdn.example/AVATAR-SCANNED/width=96', null],
    ['minor', 'avatar-Scanned', null],
    ['minor', 'legacy', 'legacy'],
    [null, 'avatar-Scanned', 'avatar-Scanned'],
  ])('a picture held %s drops a User.image %s naming it', async (hold, image, expected) => {
    row.current = { ...creatorRow('Scanned'), image, profilePictureNeedsReview: hold };
    const read = await readUserCreatorViaKysely(db, { id: 5 });
    expect(read?.user.image).toBe(expected);
  });

  it('carries a Scanned picture', async () => {
    row.current = creatorRow('Scanned');
    const read = await readUserCreatorViaKysely(db, { id: 5 });
    expect(read?.user.profilePicture?.url).toBe('avatar-Scanned');
  });
});
