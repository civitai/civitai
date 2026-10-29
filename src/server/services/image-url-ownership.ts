import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { clickhouse } from '~/server/clickhouse/client';
import { escapeClickhouseString } from '~/server/clickhouse/escape';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

/** Shown when a client-supplied image url cannot be used. Keep it actionable. */
export const COVER_IMAGE_UNAVAILABLE_MESSAGE =
  'This cover image is no longer available. Please re-upload it.';

export const ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE =
  'One of the images in this article is no longer available. Please re-upload it.';

export const imageUrlUnavailableError = (message = COVER_IMAGE_UNAVAILABLE_MESSAGE) =>
  new TRPCError({ code: 'BAD_REQUEST', message });

type Db = Prisma.TransactionClient | typeof dbWrite;

const MAX_KEYS = 64;
// Overlapping matches too: one key's characters can begin another.
const UUIDS = /(?=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))/gi;

const ESCAPE = /%([0-9a-f]{2})/gi;
const MAX_DECODE_PASSES = 8;

const compacted = (value: string) => value.replace(/[\t\r\n]/g, '');

/**
 * `value` and each form it takes as its `%XX` escapes are decoded, one pass at a time, each escape
 * on its own.
 */
function decodedForms(value: string) {
  const forms = [compacted(value)];
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const current = forms[forms.length - 1];
    const next = compacted(
      current.replace(ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    );
    if (next === current) break;
    forms.push(next);
  }
  return forms;
}

/**
 * The stored `Image.url` values that may name the same object as `url`: the url as given, and
 * every key it contains, lowercased. Keys are minted lowercase; a url can carry one in any case,
 * inside a path, percent-encoded or split by characters a url parser drops (tab, CR, LF).
 */
function storedUrlsFor(url: string | null | undefined): string[] {
  const keys = keysIn(url);
  return keys.length ? [url as string, ...keys] : [];
}

function keysIn(url: string | null | undefined): string[] {
  if (!url) return [];
  return decodedForms(url).flatMap((value) =>
    [...value.matchAll(UUIDS)].map(([, key]) => key.toLowerCase())
  );
}

/**
 * A client-supplied image url must be one the caller uploaded or already owns: refused when an
 * `Image` row owned by another user has it. Callers that verify the object exists run this after
 * that check, with the same refusal.
 */
export async function assertClientImageUrlsUsable({
  urls,
  userId,
  db = dbWrite,
}: {
  urls: (string | null | undefined)[];
  userId: number;
  db?: Db;
}) {
  const keys = [...new Set(urls.flatMap(storedUrlsFor))];
  if (!keys.length) return;
  // Bounds the lookup; no real image url carries more than a couple of keys.
  if (keys.length > MAX_KEYS) throw imageUrlUnavailableError();
  // Whatever the other row's state.
  const owned = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image" WHERE url = ANY(${keys}::text[]) AND "userId" <> ${userId} LIMIT 1
  `;
  if (owned.length) throw imageUrlUnavailableError();
}

const UPLOAD_KEY_OWNER_TTL_SECONDS = 30 * 24 * 60 * 60;
/** From then, every upload key in a client url needs an issue record or a row of the caller's. */
export const UNRECORDED_KEYS_ACCEPTED_UNTIL = new Date('2026-11-05T05:00:00Z');

const uploadKeyOwnerCounter = registerCounterWithLabels({
  name: 'upload_key_owner_total',
  help: 'Image upload key issue records: failed writes, and unrecorded keys accepted or refused on save.',
  labelNames: ['outcome'] as const,
});

const ownerKey = (key: string) =>
  `${REDIS_SYS_KEYS.SYSTEM.UPLOAD_KEY_OWNER}:${key}` as RedisKeyTemplateSys;

/** Records that upload key `key` was issued to `userId`. Never throws. */
export async function recordUploadKeyOwner(key: string, userId: number) {
  try {
    await withSysReadDeadline(
      sysRedis.set(ownerKey(key.toLowerCase()), String(userId), {
        EX: UPLOAD_KEY_OWNER_TTL_SECONDS,
      })
    );
  } catch (e) {
    uploadKeyOwnerCounter.inc({ outcome: 'record_failed' });
    logToAxiom({
      type: 'error',
      name: 'upload-key-owner',
      message: 'Failed to record upload key owner',
      error: (e as Error).message,
    }).catch(() => undefined);
  }
}

async function ownersFromRedis(keys: string[]) {
  const owners = new Map<string, number>();
  try {
    const values = await withSysReadDeadline(sysRedis.mGet(keys.map(ownerKey)));
    values.forEach((value, i) => {
      const owner = Number(value);
      if (value && owner) owners.set(keys[i], owner);
    });
    return { owners, readFailed: false };
  } catch {
    uploadKeyOwnerCounter.inc({ outcome: 'record_read_failed' });
    return { owners, readFailed: true };
  }
}

const CLICKHOUSE_LOOKUP_DEADLINE_MS = 2_000;

function withDeadline<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function ownersFromClickhouse(keys: string[]) {
  const owners = new Map<string, number>();
  if (!clickhouse || !keys.length) return { owners, failed: false };
  try {
    const list = keys.map((k) => `'${escapeClickhouseString(k)}'`).join(',');
    const rows = await withDeadline(
      clickhouse.$query<{ key: string; userId: number }>(`
        SELECT key, any(userId) AS userId
        FROM imageUploadRequests
        WHERE key IN (${list}) AND userId != 0
        GROUP BY key
      `),
      CLICKHOUSE_LOOKUP_DEADLINE_MS
    );
    // userId 0: the session lookup failed when the key was issued.
    for (const { key, userId } of rows) if (Number(userId)) owners.set(key, Number(userId));
    return { owners, failed: false };
  } catch {
    return { owners, failed: true };
  }
}

type KeyIssuerArgs = {
  urls: (string | null | undefined)[];
  userId: number;
  alsoIssuedTo?: number;
  db?: Db;
};

/**
 * The upload keys in `urls` that were issued to someone other than `userId` and `alsoIssuedTo`,
 * and those with no issue record and no `Image` row of theirs.
 */
export async function keyIssuers({ urls, userId, alsoIssuedTo, db = dbWrite }: KeyIssuerArgs) {
  const allowed = [userId, ...(alsoIssuedTo ? [alsoIssuedTo] : [])];
  const keys = [...new Set(urls.flatMap(keysIn))];
  const result = {
    tooMany: false,
    issuedToOthers: [] as string[],
    unrecorded: [] as string[],
    /** The issue record could not be read, so `unrecorded` may hold recorded keys. */
    recordReadFailed: false,
    /** The upload request log could not be read, so `unrecorded` may hold logged keys. */
    requestLogReadFailed: false,
  };
  if (!keys.length) return result;
  if (keys.length > MAX_KEYS) return { ...result, tooMany: true };

  const { owners, readFailed } = await ownersFromRedis(keys);
  result.recordReadFailed = readFailed;
  const unrecorded = keys.filter((k) => !owners.has(k));
  const logged = await ownersFromClickhouse(unrecorded);
  result.requestLogReadFailed = logged.failed;
  for (const [key, owner] of logged.owners) owners.set(key, owner);
  result.issuedToOthers = [...owners].filter(([, o]) => !allowed.includes(o)).map(([k]) => k);

  const remaining = keys.filter((k) => !owners.has(k));
  if (!remaining.length) return result;
  // A row of theirs may store the key bare or as the url given.
  const urlsByKey = new Map(remaining.map((k) => [k, [k]]));
  for (const url of urls) {
    if (!url) continue;
    for (const key of keysIn(url)) urlsByKey.get(key)?.push(url);
  }
  const candidates = [...new Set([...urlsByKey.values()].flat())];
  const own = await db.$queryRaw<{ url: string }[]>`
    SELECT url FROM "Image" WHERE url = ANY(${candidates}::text[]) AND "userId" = ANY(${allowed}::int[])
  `;
  const ownUrls = new Set(own.map((r) => r.url));
  result.unrecorded = remaining.filter((k) => !urlsByKey.get(k)?.some((u) => ownUrls.has(u)));
  return result;
}

/**
 * Every upload key in a client-supplied url must have been issued to the caller (or to
 * `alsoIssuedTo`); a key issued to another user is refused with the generic refusal.
 */
export async function assertClientKeysIssuedToCaller({
  now = new Date(),
  ...args
}: KeyIssuerArgs & { now?: Date }) {
  const { userId } = args;
  const {
    tooMany,
    issuedToOthers,
    unrecorded: remaining,
    requestLogReadFailed,
  } = await keyIssuers(args);
  if (tooMany || issuedToOthers.length) throw imageUrlUnavailableError();
  if (!remaining.length) return;

  if (requestLogReadFailed) {
    uploadKeyOwnerCounter.inc({ outcome: 'request_log_unavailable' });
    throw imageUrlUnavailableError();
  }

  if (now >= UNRECORDED_KEYS_ACCEPTED_UNTIL) {
    uploadKeyOwnerCounter.inc({ outcome: 'unrecorded_refused' });
    throw imageUrlUnavailableError();
  }
  uploadKeyOwnerCounter.inc({ outcome: 'unrecorded_accepted' });
  logToAxiom({
    type: 'info',
    name: 'upload-key-unrecorded',
    message: 'Accepted an upload key with no issue record',
    userId,
    keys: remaining.join(','),
  }).catch(() => undefined);
}
