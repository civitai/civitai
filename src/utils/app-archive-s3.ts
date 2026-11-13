import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server';
import {
  isAcceptableSeedUrl,
  seedStoreClient,
  seedStoreConfig,
  type SeedStoreConfig,
} from '~/utils/fork-seed-s3';

/**
 * APP HIBERNATE — the store a sleeping app's workspace archive and its encrypted `.env*` blob are
 * kept in (`APP_ARCHIVE_S3_*`). It shares `fork-seed-s3.ts`'s config and client: the sandbox service
 * downloads a wake's seed from this store, and it accepts seeds only from allowlisted https hosts
 * with no port, so the same endpoint rule applies. One difference matters:
 * these objects are the ONLY copy of the user's app, so nothing here expires them and every delete
 * is explicit (a superseded archive after a commit, a deleted sleeping app, a deleted account).
 *
 * Every key lives under {@link ARCHIVE_PREFIX}: the store's credential is scoped to that prefix.
 * The sandbox service never holds a credential; it gets presigned URLs only.
 */

export const ARCHIVE_PREFIX = 'archives/';

/** How long the sandbox service has to upload an archive (or the secrets blob) after `begin`. */
export const ARCHIVE_PUT_TTL_SECONDS = 15 * 60;
export type ArchiveStoreConfig = SeedStoreConfig;

/**
 * The store's settings, or `null` when this environment has none (every value is required) or
 * the endpoint is one the sandbox service would refuse (not https, or with a port).
 */
export function archiveStoreConfig(): ArchiveStoreConfig | null {
  return seedStoreConfig({
    endpoint: env.APP_ARCHIVE_S3_ENDPOINT,
    bucket: env.APP_ARCHIVE_S3_BUCKET,
    accessKeyId: env.APP_ARCHIVE_S3_ACCESS_KEY_ID,
    secretAccessKey: env.APP_ARCHIVE_S3_SECRET_ACCESS_KEY,
  });
}

/** The object keys of one hibernation attempt. civitai builds them; no caller names a key. */
export function archiveObjectKeys(userId: number, appKey: string, attemptId: string) {
  const base = `${ARCHIVE_PREFIX}${userId}/${appKey}/${attemptId}`;
  return { archive: `${base}.zip`, secrets: `${base}.secrets` };
}

/** Every object one user owns sits under this prefix. */
export function userArchivePrefix(userId: number): string {
  return `${ARCHIVE_PREFIX}${userId}/`;
}

/**
 * The operations the hibernation service needs. An interface so the service can be tested
 * against an in-memory store; {@link createArchiveStore} is the S3 implementation.
 */
export interface ArchiveStore {
  /** A presigned PUT the sandbox service will accept (https, the endpoint's host, no port). */
  presignPut(key: string, ttlSeconds?: number): Promise<string>;
  /** The object's size, or `null` when it does not exist. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** sha256 (hex) and byte count of the object AS STORED, streamed; `null` when it does not exist. */
  hash(key: string): Promise<{ sha256: string; bytes: number } | null>;
  /** The whole object, refusing one larger than `maxBytes` (`null` when it does not exist). */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Deletes the keys; a missing key is not an error. */
  deleteMany(keys: string[]): Promise<void>;
  /** Every key under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Upper bound on list pages, so a misbehaving store cannot spin a delete forever. */
const MAX_LIST_PAGES = 1_000;

export function createArchiveStore(config: ArchiveStoreConfig): ArchiveStore {
  const s3 = seedStoreClient(config);
  const Bucket = config.bucket;

  const getBody = async (key: string): Promise<Readable | null> => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return (res.Body as Readable | undefined) ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  return {
    async presignPut(key, ttlSeconds = ARCHIVE_PUT_TTL_SECONDS) {
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
      if (!isAcceptableSeedUrl(url, config.endpoint))
        throw new Error('presigned archive URL is not on the configured https endpoint');
      return url;
    },
    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { bytes: Number(res.ContentLength ?? 0) };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async hash(key) {
      const body = await getBody(key);
      if (!body) return null;
      const h = createHash('sha256');
      let bytes = 0;
      for await (const chunk of body) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
        bytes += buf.length;
        h.update(new Uint8Array(buf));
      }
      return { sha256: h.digest('hex'), bytes };
    },
    async read(key, maxBytes) {
      const body = await getBody(key);
      if (!body) return null;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of body) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
        bytes += buf.length;
        if (bytes > maxBytes) {
          body.destroy();
          throw new Error(`object ${key} is larger than ${maxBytes} bytes`);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks.map((c) => new Uint8Array(c)));
    },
    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const res = await s3.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          })
        );
        const failed = (res.Errors ?? []).filter((e) => e.Code !== 'NoSuchKey');
        if (failed.length > 0)
          throw new Error(
            `could not delete ${failed.length} archive object(s): ${failed[0]?.Code}`
          );
      }
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await s3.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token })
        );
        for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
        if (!res.IsTruncated || !res.NextContinuationToken) return keys;
        token = res.NextContinuationToken;
      }
      throw new Error(`archive listing under ${prefix} exceeded ${MAX_LIST_PAGES} pages`);
    },
  };
}
