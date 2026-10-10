import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { imageSchema } from '~/server/schema/image.schema';
import { profilePictureSchema } from '~/server/schema/user.schema';
import {
  createEntityImages,
  createImage,
  updateEntityImages,
} from '~/server/services/image.service';
import {
  BLOCK_PROVENANCE_METADATA_KEYS,
  isBlockProvenanceMetadataKey,
  stripBlockProvenanceMetadata,
} from '~/shared/utils/block-provenance-metadata';

const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';
const SERVER_APP_ID = 'verified-app-77';

// Client-shaped metadata: every provenance key, plus unrelated keys that must survive
// untouched — including near-misses of the key and a copy nested inside a value.
const CLIENT_METADATA = {
  blockPublishedAppId: 'client-app-1',
  size: 12345,
  width: 640,
  blockedAppId: 'not-provenance',
  publishedAppId: 'not-provenance-either',
  nested: { blockPublishedAppId: 'inside-a-value' },
};
const UNRELATED = {
  size: 12345,
  width: 640,
  blockedAppId: 'not-provenance',
  publishedAppId: 'not-provenance-either',
  nested: { blockPublishedAppId: 'inside-a-value' },
};

function createdMetadata(call = 0) {
  return dbMock.dbWrite.image.create.mock.calls[call][0].data.metadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: 4242 } as never);
});

describe('block provenance metadata keys', () => {
  it('lists the published key', () => {
    expect([...BLOCK_PROVENANCE_METADATA_KEYS]).toEqual(['blockPublishedAppId']);
  });

  it.each([
    ['blockPublishedAppId', true],
    ['blockedAppId', false],
    ['publishedAppId', false],
    ['blockPublishedAppIds', false],
    ['size', false],
  ])('%s → %s', (key, expected) => {
    expect(isBlockProvenanceMetadataKey(key)).toBe(expected);
  });

  it('returns the same object when there is nothing to drop', () => {
    const metadata = { size: 1 };
    expect(stripBlockProvenanceMetadata(metadata)).toBe(metadata);
    expect(stripBlockProvenanceMetadata(undefined)).toBeUndefined();
    expect(stripBlockProvenanceMetadata(null)).toBeNull();
  });
});

describe('createImage', () => {
  it('stores none of the provenance keys from client metadata, and keeps the rest', async () => {
    await createImage({
      url: KEY,
      userId: 1,
      type: 'image',
      skipIngestion: true,
      metadata: { ...CLIENT_METADATA },
    } as never);

    expect(createdMetadata()).toEqual(UNRELATED);
  });

  it('writes the key from blockProvenance, never a metadata copy of it', async () => {
    await createImage({
      url: KEY,
      userId: 1,
      type: 'image',
      skipIngestion: true,
      metadata: { ...CLIENT_METADATA },
      blockProvenance: { key: 'blockPublishedAppId', appId: SERVER_APP_ID },
    } as never);

    expect(createdMetadata()).toEqual({ ...UNRELATED, blockPublishedAppId: SERVER_APP_ID });
  });

  it('writes provenance onto a row that had no metadata', async () => {
    await createImage({
      url: KEY,
      userId: 1,
      type: 'image',
      skipIngestion: true,
      blockProvenance: { key: 'blockPublishedAppId', appId: SERVER_APP_ID },
    } as never);

    expect(createdMetadata()).toEqual({ blockPublishedAppId: SERVER_APP_ID });
  });

  it('leaves metadata absent when neither is given', async () => {
    await createImage({ url: KEY, userId: 1, type: 'image', skipIngestion: true } as never);

    expect(createdMetadata()).toBeUndefined();
  });

  it('refuses a blockProvenance without an appId', async () => {
    await expect(
      createImage({
        url: KEY,
        userId: 1,
        type: 'image',
        skipIngestion: true,
        blockProvenance: { key: 'blockPublishedAppId', appId: '' },
      } as never)
    ).rejects.toThrow('blockProvenance requires an appId');
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  });
});

describe('entity image writers', () => {
  it('createEntityImages drops provenance keys from every row', async () => {
    await createEntityImages({
      images: [{ url: KEY, type: 'image', metadata: { ...CLIENT_METADATA } }] as never,
      userId: 1,
    });

    const rows = dbMock.dbWrite.image.createMany.mock.calls[0][0].data as { metadata: unknown }[];
    expect(rows.map((r) => r.metadata)).toEqual([UNRELATED]);
  });

  it('updateEntityImages drops provenance keys from every new row', async () => {
    await updateEntityImages({
      entityId: 5,
      entityType: 'Bounty',
      images: [{ url: KEY, type: 'image', metadata: { ...CLIENT_METADATA } }] as never,
      userId: 1,
    });

    const rows = dbMock.dbWrite.image.createMany.mock.calls[0][0].data as { metadata: unknown }[];
    expect(rows.map((r) => r.metadata)).toEqual([UNRELATED]);
  });
});

describe('input schemas', () => {
  it('imageSchema drops provenance keys and keeps the rest', () => {
    const parsed = imageSchema.parse({ url: KEY, metadata: { ...CLIENT_METADATA } });
    expect(parsed.metadata).toEqual(UNRELATED);
  });

  it('imageSchema does not accept a blockProvenance field', () => {
    const parsed = imageSchema.parse({
      url: KEY,
      blockProvenance: { key: 'blockPublishedAppId', appId: 'client-app-1' },
    });
    expect(parsed).not.toHaveProperty('blockProvenance');
  });

  it('profilePictureSchema drops provenance keys and keeps the rest', () => {
    const parsed = profilePictureSchema.parse({ url: KEY, metadata: { ...CLIENT_METADATA } });
    expect(parsed.metadata).toEqual(UNRELATED);
  });
});
