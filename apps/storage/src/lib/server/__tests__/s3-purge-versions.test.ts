import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createS3Client } from '../s3';
import { fakeVersionedBucket } from './fake-versioned-bucket';

const KEY = 'a1b2c3/original.jpeg';
const SIBLING = `${KEY}.json`; // shares the prefix, must survive

let bucket: ReturnType<typeof fakeVersionedBucket>;

function client(pageSize?: number) {
  bucket = fakeVersionedBucket({ pageSize });
  bucket.putVersion(KEY);
  bucket.putVersion(KEY);
  bucket.putDeleteMarker(KEY);
  bucket.putVersion(SIBLING);
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(((command: unknown) =>
    bucket.send(command)) as never);
  return createS3Client({
    endpoint: 'http://store.test',
    accessKey: 'k',
    secretKey: 's',
    bucket: 'b',
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('purgeObjectVersions', () => {
  it('a key-only delete leaves every version behind', async () => {
    await client().deleteObject(KEY);
    // 2 versions + the existing marker + the marker this delete added.
    expect(bucket.entriesFor(KEY)).toHaveLength(4);
  });

  it('deletes every version and delete marker and reads back zero', async () => {
    const s3 = client();
    await expect(s3.purgeObjectVersions(KEY)).resolves.toEqual({
      versionsDeleted: 3,
      remaining: 0,
    });
    expect(bucket.entriesFor(KEY)).toHaveLength(0);
    expect(bucket.entriesFor(SIBLING)).toHaveLength(1);
    // The readback is a fresh listing after the deletes, not a count of what was sent.
    expect(bucket.calls.at(-1)).toBe('list');
  });

  it('follows the listing across pages', async () => {
    const s3 = client(1);
    await expect(s3.purgeObjectVersions(KEY)).resolves.toEqual({
      versionsDeleted: 3,
      remaining: 0,
    });
    expect(bucket.entriesFor(KEY)).toHaveLength(0);
    expect(bucket.calls.filter((c) => c === 'list').length).toBeGreaterThan(3);
  });

  it('reports what is left when the store keeps versions', async () => {
    const s3 = client();
    bucket.pinVersions(KEY);
    await expect(s3.purgeObjectVersions(KEY)).resolves.toEqual({
      versionsDeleted: 3,
      remaining: 3,
    });
  });

  it('is a no-op for a key with no versions', async () => {
    const s3 = client();
    await expect(s3.purgeObjectVersions('missing/key')).resolves.toEqual({
      versionsDeleted: 0,
      remaining: 0,
    });
  });
});
