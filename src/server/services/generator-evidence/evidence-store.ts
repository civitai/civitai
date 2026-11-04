import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { env } from '~/env/server';
import type { EvidenceStore } from '~/server/services/generator-evidence/preserve-blob';

function evidenceBucket() {
  if (
    !env.CSAM_UPLOAD_KEY ||
    !env.CSAM_UPLOAD_SECRET ||
    !env.CSAM_UPLOAD_REGION ||
    !env.CSAM_UPLOAD_ENDPOINT ||
    !env.CSAM_BUCKET_NAME
  )
    throw new Error('missing CSAM env vars');
  const client = new S3Client({
    credentials: { accessKeyId: env.CSAM_UPLOAD_KEY, secretAccessKey: env.CSAM_UPLOAD_SECRET },
    region: env.CSAM_UPLOAD_REGION,
    endpoint: env.CSAM_UPLOAD_ENDPOINT,
  });
  return { client, Bucket: env.CSAM_BUCKET_NAME };
}

/** The whole object, for a send or a moderator's view. */
export async function readEvidenceObject(key: string) {
  const { client, Bucket } = evidenceBucket();
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error('the evidence object has no body');
  return { bytes, contentType: res.ContentType };
}

export function sha256Hex(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The object's sha256, hashed as it streams: the file is never held whole. */
export async function hashEvidenceObject(key: string) {
  const { client, Bucket } = evidenceBucket();
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  if (!res.Body) throw new Error('the evidence object has no body');
  const hash = createHash('sha256');
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest('hex');
}

export function csamEvidenceStore(): EvidenceStore {
  const { client, Bucket } = evidenceBucket();
  return {
    read: async (key: string) => (await readEvidenceObject(key)).bytes,
    async upload(key: string, body: Readable, contentType: string) {
      await new Upload({
        client,
        params: { Bucket, Key: key, Body: body, ContentType: contentType },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
    },
    async head(key: string) {
      const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
      return typeof res.ContentLength === 'number' ? { bytes: res.ContentLength } : null;
    },
    sha256: hashEvidenceObject,
  };
}
