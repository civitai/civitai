import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server';
import { isAcceptableSeedUrl, seedStoreClient, seedStoreConfig } from '~/utils/fork-seed-s3';
import { newS3Client } from '~/utils/s3-client-factory';

/**
 * APP HIBERNATE — the store a sleeping app's workspace archive and its encrypted `.env*` blob are
 * kept in (`APP_ARCHIVE_S3_*`). These objects are the ONLY copy of the user's app, so nothing here
 * expires them and every delete is explicit (a superseded archive after a commit, a deleted
 * sleeping app, a deleted account, the orphan sweep).
 *
 * TWO ENDPOINTS for one bucket:
 *   - `APP_ARCHIVE_S3_ENDPOINT` for every call civitai makes itself (head, copy, get/hash, put,
 *     list, delete). It may be plain http and carry a port.
 *   - `APP_ARCHIVE_S3_PUBLIC_ENDPOINT` ONLY to presign the URLs handed to the sandbox service. The
 *     sandbox service accepts seeds only from allowlisted https hosts with no port, so this one
 *     follows `fork-seed-s3.ts`'s rule (and shares its config check and client), and every
 *     presigned URL is checked against it. Unset or not https/portless, nothing is presigned (the
 *     hibernation endpoints answer `not_configured`); civitai never falls back to presigning on
 *     the in-cluster endpoint.
 *
 * Every key lives under {@link ARCHIVE_PREFIX}: the store's credential is scoped to that prefix.
 * The sandbox service never holds a credential; it gets presigned URLs only.
 */

export const ARCHIVE_PREFIX = 'archives/';

/** How long the sandbox service has to upload an archive (or the secrets blob) after `begin`. */
export const ARCHIVE_PUT_TTL_SECONDS = 15 * 60;
export type ArchiveStoreConfig = {
  /** In-cluster: civitai's own calls. http or https, any port. */
  endpoint: string;
  /** Public: presigned URLs only. https and no port, or `null` (nothing can be presigned). */
  publicEndpoint: string | null;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Why a SET public endpoint is unusable for presigning, or `null` when it is fine. */
export function publicEndpointProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'it is not a URL';
  }
  if (u.protocol !== 'https:') return `it is not https (${u.protocol})`;
  if (u.port !== '') return `it has a port (${u.port})`;
  return null;
}

/** One warning per distinct value: the value is read on every request and does not change. */
let warnedPublicEndpoint: string | null = null;

/**
 * The store's settings, or `null` when this environment has no in-cluster endpoint, bucket or
 * key (every one is required). A public endpoint that is unset, or that the sandbox service would
 * refuse (not https, or with a port), leaves `publicEndpoint` null: civitai's own calls (account
 * deletion and the sweep included) still work, and nothing is presigned.
 */
export function archiveStoreConfig(): ArchiveStoreConfig | null {
  const endpoint = env.APP_ARCHIVE_S3_ENDPOINT;
  const bucket = env.APP_ARCHIVE_S3_BUCKET;
  const accessKeyId = env.APP_ARCHIVE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.APP_ARCHIVE_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  const publicValue = env.APP_ARCHIVE_S3_PUBLIC_ENDPOINT;
  const problem = publicValue ? publicEndpointProblem(publicValue) : null;
  if (problem && publicValue && warnedPublicEndpoint !== publicValue) {
    warnedPublicEndpoint = publicValue;
    // Set but unusable is a misconfiguration, not "unset": say so once, loudly.
    console.warn(
      `[app-hibernation] APP_ARCHIVE_S3_PUBLIC_ENDPOINT is set but ignored because ${problem}; ` +
        'the sandbox service accepts only https URLs with no port, so nothing will be presigned ' +
        'and hibernation answers not_configured.'
    );
  }
  const publicStore = seedStoreConfig({
    endpoint: publicValue,
    bucket,
    accessKeyId,
    secretAccessKey,
  });
  return {
    endpoint,
    publicEndpoint: publicStore?.endpoint ?? null,
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

/**
 * The UPLOAD key of one hibernation attempt: the one `begin` presigns a PUT for. civitai builds
 * every key; no caller names one.
 */
export function archiveObjectKeys(userId: number, appKey: string, attemptId: string) {
  return { archive: `${ARCHIVE_PREFIX}${userId}/${appKey}/${attemptId}.zip` };
}

/**
 * The keys ONE commit invocation writes: the copy of the upload it verifies and records, and the
 * `.env*` blob it seals. `invocation` is random per call, so two overlapping commits of one attempt
 * (a slow one and its retry) never write the same object. No presigned URL ever names a kept key,
 * so nothing outside civitai can overwrite a committed archive or its secrets. Both sit under the
 * user's prefix, so account deletion and the orphan sweep find them.
 */
export function keptObjectKeys(
  userId: number,
  appKey: string,
  attemptId: string,
  invocation: string
) {
  const base = `${ARCHIVE_PREFIX}${userId}/${appKey}/${attemptId}.${invocation}`;
  return { keptArchive: `${base}.kept.zip`, keptSecrets: `${base}.kept.secrets` };
}

/** Thrown by `hash` / `read` once an object streams past the byte limit they were given. */
export class ArchiveObjectTooLarge extends Error {}

/** Every object one user owns sits under this prefix. */
export function userArchivePrefix(userId: number): string {
  return `${ARCHIVE_PREFIX}${userId}/`;
}

/**
 * The operations the hibernation service needs. An interface so the service can be tested
 * against an in-memory store; {@link createArchiveStore} is the S3 implementation.
 */
export interface ArchiveStore {
  /** Whether a public endpoint is configured, so URLs can be presigned for the sandbox service. */
  readonly canPresign: boolean;
  /**
   * A presigned PUT on the PUBLIC endpoint (https, its host, no port). Throws when there is no
   * public endpoint: it never falls back to the in-cluster one.
   */
  presignPut(key: string, ttlSeconds?: number): Promise<string>;
  /** The object's size, or `null` when it does not exist. */
  head(key: string): Promise<{ bytes: number } | null>;
  /**
   * sha256 (hex) and byte count of the object AS STORED, streamed; `null` when it does not exist.
   * Throws {@link ArchiveObjectTooLarge} as soon as more than `maxBytes` have streamed.
   */
  hash(key: string, maxBytes: number): Promise<{ sha256: string; bytes: number } | null>;
  /** The whole object; throws {@link ArchiveObjectTooLarge} past `maxBytes` (`null` when absent). */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Writes `body` at `key` (civitai's own write; never presigned). */
  put(key: string, body: Buffer): Promise<void>;
  /** Server-side copy of `from` to `to`; `false` when `from` does not exist. */
  copy(from: string, to: string): Promise<boolean>;
  /** Deletes the keys; a missing key is not an error. */
  deleteMany(keys: string[]): Promise<void>;
  /** Every object under `prefix`, with when it was last written. */
  list(prefix: string): Promise<{ key: string; lastModified: Date }[]>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Upper bound on list pages, so a misbehaving store cannot spin a delete forever. */
const MAX_LIST_PAGES = 1_000;

/**
 * The S3 implementation. `requestHandler` replaces the in-cluster client's transport (tests use
 * it to see where a direct call goes without a network).
 */
export function createArchiveStore(
  config: ArchiveStoreConfig,
  opts: { requestHandler?: S3ClientConfig['requestHandler'] } = {}
): ArchiveStore {
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  // Every call civitai makes itself.
  const s3 = newS3Client({
    endpoint: config.endpoint,
    region: 'us-east-1',
    credentials,
    forcePathStyle: true,
    ...(opts.requestHandler ? { requestHandler: opts.requestHandler } : {}),
  });
  // Presigning only; a client on the public endpoint, never used to send a request.
  const publicEndpoint = config.publicEndpoint;
  const presigner = publicEndpoint
    ? seedStoreClient({ endpoint: publicEndpoint, bucket: config.bucket, ...credentials })
    : null;
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
    canPresign: !!presigner,
    async presignPut(key, ttlSeconds = ARCHIVE_PUT_TTL_SECONDS) {
      if (!presigner || !publicEndpoint)
        throw new Error('no public archive endpoint: nothing can be presigned');
      const url = await getSignedUrl(presigner, new PutObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
      if (!isAcceptableSeedUrl(url, publicEndpoint))
        throw new Error('presigned archive URL is not on the public https endpoint');
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
    async hash(key, maxBytes) {
      const body = await getBody(key);
      if (!body) return null;
      const h = createHash('sha256');
      let bytes = 0;
      for await (const chunk of body) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
        bytes += buf.length;
        if (bytes > maxBytes) {
          body.destroy();
          throw new ArchiveObjectTooLarge(`object ${key} is larger than ${maxBytes} bytes`);
        }
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
          throw new ArchiveObjectTooLarge(`object ${key} is larger than ${maxBytes} bytes`);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks.map((c) => new Uint8Array(c)));
    },
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: new Uint8Array(body) }));
    },
    async copy(from, to) {
      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket,
            Key: to,
            CopySource: `${Bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
          })
        );
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
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
      const keys: { key: string; lastModified: Date }[] = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await s3.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token })
        );
        for (const o of res.Contents ?? [])
          if (o.Key) keys.push({ key: o.Key, lastModified: o.LastModified ?? new Date() }); // unknown age: never old enough to sweep
        if (!res.IsTruncated || !res.NextContinuationToken) return keys;
        token = res.NextContinuationToken;
      }
      throw new Error(`archive listing under ${prefix} exceeded ${MAX_LIST_PAGES} pages`);
    },
  };
}
