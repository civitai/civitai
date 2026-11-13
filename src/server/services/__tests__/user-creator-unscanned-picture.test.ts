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

  it('carries no Scanned picture flagged csam', async () => {
    row.current = { ...creatorRow('Scanned'), profilePictureNeedsReview: 'csam' };
    const read = await readUserCreatorViaKysely(db, { id: 5 });
    expect(read?.user.profilePicture).toBeNull();
  });

  it('the profile read drops a picture flagged csam for every viewer, its owner included', () => {
    // `profilePictureOf` also builds the profile read's picture (hot-reads-9), whose owner branch
    // otherwise serves the owner their own unscanned picture.
    const flagged = { ...creatorRow('Scanned'), profilePictureNeedsReview: 'csam' };
    expect(profilePictureOf(flagged as never)).toBeNull();
    expect(profilePictureOf(creatorRow('Pending') as never)?.url).toBe('avatar-Pending');
  });

  it('carries a Scanned picture', async () => {
    row.current = creatorRow('Scanned');
    const read = await readUserCreatorViaKysely(db, { id: 5 });
    expect(read?.user.profilePicture?.url).toBe('avatar-Scanned');
  });
});
