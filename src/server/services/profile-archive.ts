import { createHash } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ProfileClearSnapshot } from '~/server/services/user.service';

/** Where a profile snapshot was stored, and the sha256 of its exact bytes, checked on a re-read. */
export type StoredProfileArchive = { key: string; sha256: string };

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function serializeProfileArchive(snapshot: ProfileClearSnapshot, archivedAt: Date) {
  const body = Buffer.from(
    JSON.stringify({
      userId: snapshot.userId,
      archivedAt: archivedAt.toISOString(),
      actorId: snapshot.actorId,
      clearedFields: snapshot.clearedFields,
      profile: snapshot.profile,
      links: snapshot.links,
    }),
    'utf8'
  );
  return { body, sha256: sha256Hex(body) };
}

/**
 * Stores `profile.json` for `snapshot` with its sha256 in the object's metadata, then reads the
 * object back and throws unless the bytes stored hash to that value, so a caller that awaits this
 * never changes a profile whose snapshot is missing or altered.
 */
export async function storeVerifiedProfileArchive({
  client,
  Bucket,
  snapshot,
  now = new Date(),
}: {
  client: Pick<S3Client, 'send'>;
  Bucket: string;
  snapshot: ProfileClearSnapshot;
  now?: Date;
}): Promise<StoredProfileArchive> {
  const { body, sha256 } = serializeProfileArchive(snapshot, now);
  const key = `${snapshot.userId}/${now.getTime()}_profile.json`;
  await client.send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      Metadata: { sha256 },
    })
  );
  const reread = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  const bytes = await reread.Body?.transformToByteArray();
  if (!bytes) throw new Error(`profile archive ${key} could not be read back`);
  const readHash = sha256Hex(bytes);
  if (readHash !== sha256 || reread.Metadata?.sha256 !== sha256)
    throw new Error(`profile archive ${key} does not match its sha256`);
  return { key, sha256 };
}
