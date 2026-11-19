import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { fakeVersionedBucket } from '~/__tests__/mocks/fake-versioned-bucket';
import { purgeObjectVersions } from '~/utils/s3-purge-versions';

const KEY = 'a1b2c3/original.jpeg';
const SIBLING = `${KEY}.json`; // shares the prefix, must survive

function seeded(pageSize?: number) {
  const bucket = fakeVersionedBucket({ pageSize });
  bucket.putVersion(KEY);
  bucket.putVersion(KEY);
  bucket.putDeleteMarker(KEY);
  bucket.putVersion(SIBLING);
  return bucket;
}

describe('purgeObjectVersions', () => {
  it('a key-only delete leaves every version behind', async () => {
    const bucket = seeded();
    await bucket.send(new DeleteObjectCommand({ Bucket: 'b', Key: KEY }));
    expect(bucket.entriesFor(KEY)).toHaveLength(4);
  });

  it('deletes every version and delete marker and reads back zero', async () => {
    const bucket = seeded();
    await expect(purgeObjectVersions({ client: bucket, bucket: 'b', key: KEY })).resolves.toEqual({
      versionsDeleted: 3,
      remaining: 0,
    });
    expect(bucket.entriesFor(KEY)).toHaveLength(0);
    expect(bucket.entriesFor(SIBLING)).toHaveLength(1);
    expect(bucket.calls.at(-1)).toBe('list');
  });

  it('follows the listing across pages', async () => {
    const bucket = seeded(1);
    await expect(purgeObjectVersions({ client: bucket, bucket: 'b', key: KEY })).resolves.toEqual({
      versionsDeleted: 3,
      remaining: 0,
    });
    expect(bucket.entriesFor(KEY)).toHaveLength(0);
  });

  it('reports what is left when the store keeps versions', async () => {
    const bucket = seeded();
    bucket.pinVersions(KEY);
    await expect(purgeObjectVersions({ client: bucket, bucket: 'b', key: KEY })).resolves.toEqual({
      versionsDeleted: 3,
      remaining: 3,
    });
  });
});
