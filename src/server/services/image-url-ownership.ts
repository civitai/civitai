import { Prisma } from '@prisma/client';
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

export const UNFINISHED_UPLOAD_MESSAGE =
  "An image didn't finish uploading. Remove it and add it again.";

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * A url with a scheme other than http(s), such as the `blob:` url a browser shows for a file
 * before its upload finishes. It names no stored object, so it holds no upload key.
 */
export function isUnfinishedUploadUrl(url: string | null | undefined) {
  const scheme = url ? SCHEME.exec(compacted(url).trim())?.[1].toLowerCase() : undefined;
  return !!scheme && scheme !== 'http' && scheme !== 'https';
}

/** Refuses a save holding an image url that names no stored object. */
export function assertNoUnfinishedUploads(urls: (string | null | undefined)[]) {
  if (urls.some(isUnfinishedUploadUrl))
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNFINISHED_UPLOAD_MESSAGE });
}

type Db = Prisma.TransactionClient | typeof dbWrite;

export const MAX_KEYS = 64;
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

export function keysIn(url: string | null | undefined): string[] {
  if (!url || isUnfinishedUploadUrl(url)) return [];
  return decodedForms(url).flatMap((value) =>
    [...value.matchAll(UUIDS)].map(([, key]) => key.toLowerCase())
  );
}

/**
 * The key a stored shop artwork value names, normalised as `storedUrlsFor` normalises a url: shop
 * columns hold whatever the client sent. 🔴 Must match the expression indexes in migration
 * `20261211120000_shop_artwork_key_indexes` exactly, or every image create scans these tables.
 */
export const keyIn = (column: string) =>
  Prisma.raw(
    `substring(replace(translate(lower(${column}), E'\\t\\r\\n', ''), '%2d', '-') from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')`
  );

/** Cosmetics outside the shop (event badges and the like) hold no artwork a buyer paid for. */
const soldInShop = Prisma.sql`EXISTS (SELECT 1 FROM "CosmeticShopItem" s WHERE s."cosmeticId" = "Cosmetic".id)`;

/**
 * Set by a shop artwork write: the row being written, `{}` for a new one. Its own key does not count
 * as another row's.
 */
export type ShopArtworkRow = {
  cosmeticId?: number | null;
  shopItemId?: number | null;
  itemDefinitionId?: number | null;
};

/**
 * A client-supplied image url must be one the caller uploaded or already owns: refused when an
 * `Image` row owned by another user has it, or when shop artwork (a cosmetic, a pack cover or a box
 * image) other than `shopRow`'s own already uses it. An image delete removes the object, so a key
 * shared across those rows would take the other row's artwork with it. For the same reason shop
 * artwork (`shopRow` set) is refused on any `Image` row's key, the caller's own included, and must
 * be the bare key, so the stored value is the key an image create looks up. Callers that verify
 * the object exists run this after that check, with the same refusal.
 *
 * `shopArtwork: false` checks `Image` rows only: for urls an article already stores, which a save
 * or rescan must not start refusing.
 */
export async function assertClientImageUrlsUsable({
  urls,
  userId,
  shopRow,
  shopArtwork = true,
  db = dbWrite,
}: {
  urls: (string | null | undefined)[];
  userId: number;
  shopRow?: ShopArtworkRow;
  shopArtwork?: boolean;
  db?: Db;
}) {
  if (shopRow && !shopArtwork)
    throw new Error(
      'assertClientImageUrlsUsable: a shop artwork write needs the shop artwork check'
    );
  assertNoUnfinishedUploads(urls);
  if (
    shopRow &&
    urls.some((url) => url && storedUrlsFor(url).length && storedUrlsFor(url)[1] !== url)
  )
    throw imageUrlUnavailableError();
  const keys = [...new Set(urls.flatMap(storedUrlsFor))];
  if (!keys.length) return;
  // Bounds the lookup; no real image url carries more than a couple of keys.
  if (keys.length > MAX_KEYS) throw imageUrlUnavailableError();
  if (!shopArtwork) {
    const owned = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM "Image" WHERE url = ANY(${keys}::text[]) AND "userId" <> ${userId} LIMIT 1
    `;
    if (owned.length) throw imageUrlUnavailableError();
    return;
  }
  // Whatever the other row's state.
  const owned = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image" WHERE url = ANY(${keys}::text[])
      AND (${shopRow !== undefined} OR "userId" <> ${userId})
    UNION ALL
    SELECT 1 FROM "Cosmetic" WHERE ${keyIn(`"data"->>'url'`)} = ANY(${keys}::text[])
      AND ${soldInShop}
      AND id IS DISTINCT FROM ${shopRow?.cosmeticId ?? null}::int
    UNION ALL
    SELECT 1 FROM "CosmeticShopItem" WHERE ${keyIn(`"meta"->>'coverUrl'`)} = ANY(${keys}::text[])
      AND id IS DISTINCT FROM ${shopRow?.shopItemId ?? null}::int
    UNION ALL
    SELECT 1 FROM "ItemDefinition" WHERE ${keyIn(`"imageUrl"`)} = ANY(${keys}::text[])
      AND id IS DISTINCT FROM ${shopRow?.itemDefinitionId ?? null}::int
    UNION ALL
    SELECT 1 FROM "ImageCdnShopTakedown" WHERE url = ANY(${keys}::text[])
    LIMIT 1
  `;
  if (owned.length) throw imageUrlUnavailableError();
}

/** The urls among `urls` that name a key shop artwork uses. */
export async function shopArtworkUrls(urls: string[], db: Db = dbWrite): Promise<Set<string>> {
  const keysByUrl = new Map(urls.map((url) => [url, storedUrlsFor(url).slice(1)]));
  const keys = [...new Set([...keysByUrl.values()].flat())];
  if (!keys.length) return new Set();
  const used = await db.$queryRaw<{ key: string }[]>`
    SELECT k AS key FROM unnest(${keys}::text[]) k
    WHERE EXISTS (SELECT 1 FROM "Cosmetic" WHERE ${keyIn(`"data"->>'url'`)} = k AND ${soldInShop})
      OR EXISTS (SELECT 1 FROM "CosmeticShopItem" WHERE ${keyIn(`"meta"->>'coverUrl'`)} = k)
      OR EXISTS (SELECT 1 FROM "ItemDefinition" WHERE ${keyIn(`"imageUrl"`)} = k)
      -- A taken-down listing's art, after the listing is gone: a label still points at it.
      OR EXISTS (SELECT 1 FROM "ImageCdnShopTakedown" WHERE url = k)
  `;
  const usedKeys = new Set(used.map((row) => row.key));
  return new Set(urls.filter((url) => keysByUrl.get(url)?.some((key) => usedKeys.has(key))));
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
      // The alias must not be `userId`: ClickHouse would resolve the WHERE column to the aggregate.
      clickhouse.$query<{ key: string; owner: number }>(`
        SELECT key, any(userId) AS owner
        FROM imageUploadRequests
        WHERE key IN (${list}) AND userId != 0
        GROUP BY key
      `),
      CLICKHOUSE_LOOKUP_DEADLINE_MS
    );
    // userId 0: the session lookup failed when the key was issued.
    for (const { key, owner } of rows) if (Number(owner)) owners.set(key, Number(owner));
    return { owners, failed: false };
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'upload-key-owner',
      message: 'Failed to read the upload request log',
      error: (e as Error).message,
    }).catch(() => undefined);
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
  assertNoUnfinishedUploads(args.urls);
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

async function ownersFromShopArtwork(keys: string[], db: Db) {
  const owners = new Map<string, number>();
  if (!keys.length) return owners;
  const rows = await db.$queryRaw<{ key: string; userId: number }[]>`
    SELECT key, "userId" FROM "ShopArtworkKeyOwner" WHERE key = ANY(${keys}::text[])
  `;
  for (const { key, userId } of rows) owners.set(key, userId);
  return owners;
}

/**
 * The owner each key's issue record names: the record, then shop artwork's copy of it, then the
 * upload request log. No row of anyone's counts. `failed`: a read failed, so a key missing from
 * `owners` may still have a record.
 */
export async function keyIssueRecords(keys: string[], db: Db = dbWrite) {
  const recorded = await ownersFromRedis(keys);
  const kept = await ownersFromShopArtwork(
    keys.filter((k) => !recorded.owners.has(k)),
    db
  );
  for (const [key, owner] of kept) recorded.owners.set(key, owner);
  const logged = await ownersFromClickhouse(keys.filter((k) => !recorded.owners.has(k)));
  for (const [key, owner] of logged.owners) recorded.owners.set(key, owner);
  return { owners: recorded.owners, failed: recorded.readFailed || logged.failed };
}

/**
 * Shop artwork: each url must be a bare upload key with an issue record naming `userId` or
 * `alsoIssuedTo`. Unlike `assertClientKeysIssuedToCaller`, a row of theirs is no proof and an
 * unrecorded key is refused at once. Each proven key's owner is kept, so the proof outlives the
 * record and the log.
 */
export async function assertShopArtworkKeysIssued({
  urls,
  userId,
  alsoIssuedTo,
  db = dbWrite,
}: KeyIssuerArgs) {
  const allowed = [userId, ...(alsoIssuedTo ? [alsoIssuedTo] : [])];
  assertNoUnfinishedUploads(urls);
  const given = urls.filter((url): url is string => !!url);
  // Shop artwork is stored as the bare key the upload issued, never as a url.
  if (given.some((url) => keysIn(url)[0] !== url)) throw imageUrlUnavailableError();
  const keys = [...new Set(given)];
  if (!keys.length) return;
  if (keys.length > MAX_KEYS) throw imageUrlUnavailableError();

  const { owners, failed } = await keyIssueRecords(keys, db);
  if ([...owners.values()].some((owner) => !allowed.includes(owner)))
    throw imageUrlUnavailableError();
  if (owners.size) {
    const proven = [...owners];
    await db.$executeRaw`
      INSERT INTO "ShopArtworkKeyOwner" (key, "userId")
      SELECT * FROM unnest(${proven.map(([k]) => k)}::text[], ${proven.map(([, o]) => o)}::int[])
      ON CONFLICT (key) DO NOTHING
    `;
  }

  if (keys.every((k) => owners.has(k))) return;
  uploadKeyOwnerCounter.inc({ outcome: failed ? 'request_log_unavailable' : 'unrecorded_refused' });
  throw imageUrlUnavailableError();
}
