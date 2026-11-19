import { DeleteObjectCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PurgeObjectVersionsResult } from './schema';

type Sender = Pick<S3Client, 'send'>;

/** Every version and delete marker stored under exactly `key` (a prefix listing also returns longer keys). */
async function listKeyVersions(
  client: Sender,
  bucket: string,
  key: string,
  abortSignal?: AbortSignal
) {
  const versionIds: string[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
      { abortSignal }
    );
    for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
      if (v.Key === key && v.VersionId) versionIds.push(v.VersionId);
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return versionIds;
}

/**
 * Deletes every version and delete marker of `key` by VersionId, then lists again: `remaining` is what
 * that second listing found, not a count of what was sent. On a versioned bucket a key-only delete
 * only adds a delete marker. Server-side only: it is a subpath export so the client never loads the SDK.
 */
export async function purgeObjectVersions({
  client,
  bucket,
  key,
  abortSignal,
}: {
  client: Sender;
  bucket: string;
  key: string;
  abortSignal?: AbortSignal;
}): Promise<PurgeObjectVersionsResult> {
  const versionIds = await listKeyVersions(client, bucket, key, abortSignal);
  for (const VersionId of versionIds)
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId }), {
      abortSignal,
    });
  const remaining = (await listKeyVersions(client, bucket, key, abortSignal)).length;
  return { versionsDeleted: versionIds.length, remaining };
}
