import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

export type PreservedStoreConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
};

export class UnlistedKeyError extends Error {
  constructor() {
    super('That key is not on the allowlist.');
    this.name = 'UnlistedKeyError';
  }
}

export class OversizeObjectError extends Error {
  constructor() {
    super('The object is larger than allowed.');
    this.name = 'OversizeObjectError';
  }
}

type Body = AsyncIterable<Uint8Array> & { destroy?: () => void };

/**
 * GetObject and nothing else, for the keys `isListed` names. Any other key throws before a request
 * is built, so no caller can point this credential at the rest of the bucket.
 */
export function createPreservedObjectStore(
  config: PreservedStoreConfig,
  isListed: (key: string) => boolean
) {
  const client = new S3Client({
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    endpoint: config.endpoint,
    region: config.region,
  });

  return {
    /** The whole object in memory, or `null` when the store does not have it. */
    async read(
      key: string,
      maxBytes: number,
      signal?: AbortSignal
    ): Promise<Uint8Array<ArrayBuffer> | null> {
      if (!isListed(key)) throw new UnlistedKeyError();
      let res;
      try {
        res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
          abortSignal: signal,
        });
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return null;
        throw e;
      }
      const body = res.Body as Body | undefined;
      if (!body) throw new Error('The store answered with no body.');
      return readCapped(body, maxBytes);
    },
  };
}

async function readCapped(body: Body, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      throw new OversizeObjectError();
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
