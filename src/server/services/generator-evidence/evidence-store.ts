import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { getCsamBucket } from '~/server/services/csam-bucket';
import type { EvidenceStore } from '~/server/services/generator-evidence/preserve-blob';

/** The object's bytes as they stream, never collected into one buffer. */
export async function streamEvidenceObject(key: string) {
  const { client, Bucket } = getCsamBucket();
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  if (!res.Body) throw new Error('the evidence object has no body');
  return { chunks: res.Body as AsyncIterable<Uint8Array>, contentType: res.ContentType };
}

/** The object's sha256, hashed as it streams: the file is never held whole. */
export async function hashEvidenceObject(key: string) {
  const hash = createHash('sha256');
  for await (const chunk of (await streamEvidenceObject(key)).chunks) hash.update(chunk);
  return hash.digest('hex');
}

export function csamEvidenceStore(): EvidenceStore {
  const { client, Bucket } = getCsamBucket();
  return {
    async read(key: string, limit: number) {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of (await streamEvidenceObject(key)).chunks) {
        parts.push(chunk);
        size += chunk.byteLength;
        if (size > limit) break;
      }
      return Buffer.concat(parts).subarray(0, limit + 1);
    },
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
