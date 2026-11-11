import { describe, expect, it, vi } from 'vitest';
import type * as HotReads10 from '@civitai/db-queries/hot-reads-10';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';

// The Kysely reads that carry a content owner's profile picture to every viewer (post detail,
// model version owner, collection) carry it only once Scanned.

const rows = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionOwnerWithCosmetics: vi.fn(async () => rows.current),
}));
vi.mock('@civitai/db-queries/hot-reads-10', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads10>()),
  getCollectionByIdRow: vi.fn(async () => rows.current),
}));

import { readModelVersionOwnerViaKysely } from '~/server/services/hot-reads-6.reads';
import { readCollectionByIdViaKysely } from '~/server/services/hot-reads-10.reads';

const picture = (ingestion: string) => ({
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
const ownerRow = (ingestion: string) => ({
  id: 5,
  username: 'owner',
  deletedAt: null,
  image: null,
  cosmetics: [],
  ...picture(ingestion),
});
const collectionRow = (ingestion: string) => ({
  id: 1,
  name: 'c',
  description: null,
  read: 'Public',
  write: 'Private',
  type: null,
  nsfw: false,
  nsfwLevel: 1,
  coverId: null,
  coverTags: [],
  mode: null,
  metadata: {},
  availability: 'Public',
  archivedAt: null,
  userId: 5,
  tags: [],
  ownerId: 5,
  ownerUsername: 'owner',
  ownerDeletedAt: null,
  ownerImage: null,
  cosmetics: [],
  ...picture(ingestion),
});
const db = {} as never;

describe('Kysely reads of a content owner', () => {
  it.each(['Pending', 'Error'])('carry no %s picture', async (state) => {
    rows.current = ownerRow(state);
    expect((await readModelVersionOwnerViaKysely(db, 1))?.model.user.profilePicture).toBeNull();
    rows.current = collectionRow(state);
    expect((await readCollectionByIdViaKysely(db, 1))?.user.profilePicture).toBeNull();
  });

  it('carry no Scanned picture flagged csam', async () => {
    rows.current = { ...ownerRow('Scanned'), profilePictureNeedsReview: 'csam' };
    expect((await readModelVersionOwnerViaKysely(db, 1))?.model.user.profilePicture).toBeNull();
    rows.current = { ...collectionRow('Scanned'), profilePictureNeedsReview: 'csam' };
    expect((await readCollectionByIdViaKysely(db, 1))?.user.profilePicture).toBeNull();
  });

  it('carry a Scanned picture', async () => {
    rows.current = ownerRow('Scanned');
    expect((await readModelVersionOwnerViaKysely(db, 1))?.model.user.profilePicture?.url).toBe(
      'avatar-Scanned'
    );
    rows.current = collectionRow('Scanned');
    expect((await readCollectionByIdViaKysely(db, 1))?.user.profilePicture?.url).toBe(
      'avatar-Scanned'
    );
  });
});
