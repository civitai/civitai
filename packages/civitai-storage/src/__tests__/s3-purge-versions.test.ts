import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { purgeObjectVersions } from '../s3-purge-versions';
import { fakeVersionedBucket } from '../testing/fake-versioned-bucket';

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

  // A request that drops its paging markers would otherwise list page one forever.
  it('the fake bucket fails a listing that never advances', async () => {
    const bucket = seeded(1);
    const client = {
      send: (command: { input: { KeyMarker?: string; VersionIdMarker?: string } }) => {
        command.input.KeyMarker = undefined;
        command.input.VersionIdMarker = undefined;
        return bucket.send(command);
      },
    };
    await expect(
      purgeObjectVersions({ client: client as never, bucket: 'b', key: KEY })
    ).rejects.toThrow(/more than 50 listings/);
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
