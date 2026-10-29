import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';

/** Shown when a client-supplied image url cannot be used. Keep it actionable. */
export const COVER_IMAGE_UNAVAILABLE_MESSAGE =
  'This cover image is no longer available. Please re-upload it.';

export const imageUrlUnavailableError = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: COVER_IMAGE_UNAVAILABLE_MESSAGE });

type Db = Prisma.TransactionClient | typeof dbWrite;

const MAX_KEYS = 64;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The stored `Image.url` values that may name the same object as `url`: the url as given, and
 * every key it contains, lowercased. Keys are minted lowercase; a url can carry one in any case,
 * inside a path, percent-encoded or split by characters a url parser drops (tab, CR, LF).
 */
function storedUrlsFor(url: string | null | undefined): string[] {
  if (!url) return [];
  const compact = url.replace(/[\t\r\n]/g, '');
  const keys = [compact, decoded(compact)].flatMap((value) =>
    [...value.matchAll(UUIDS)].map(([key]) => key.toLowerCase())
  );
  return keys.length ? [url, ...keys] : [];
}

/**
 * The key a stored shop artwork value names, normalised as `storedUrlsFor` normalises a url: shop
 * columns hold whatever the client sent. 🔴 Must match the expression indexes in migration
 * `20261211120000_shop_artwork_key_indexes` exactly, or every image create scans these tables.
 */
const keyIn = (column: string) =>
  Prisma.raw(
    `substring(replace(translate(lower(${column}), E'\\t\\r\\n', ''), '%2d', '-') from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')`
  );

/** The shop row being edited, whose own artwork key does not count as another row's. */
export type ShopArtworkRow = {
  cosmeticId?: number | null;
  shopItemId?: number | null;
  itemDefinitionId?: number | null;
};

/**
 * A client-supplied image url must be one the caller uploaded or already owns: refused when an
 * `Image` row owned by another user has it, or when shop artwork (a cosmetic, a pack cover or a box
 * image) other than `shopRow`'s own already uses it. An image delete removes the object, so a key
 * shared across those rows would take the other row's artwork with it. Callers that verify the
 * object exists run this after that check, with the same refusal.
 */
export async function assertClientImageUrlsUsable({
  urls,
  userId,
  shopRow,
  db = dbWrite,
}: {
  urls: (string | null | undefined)[];
  userId: number;
  shopRow?: ShopArtworkRow;
  db?: Db;
}) {
  const keys = [...new Set(urls.flatMap(storedUrlsFor))];
  if (!keys.length) return;
  // Bounds the lookup; no real image url carries more than a couple of keys.
  if (keys.length > MAX_KEYS) throw imageUrlUnavailableError();
  // Whatever the other row's state.
  const owned = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image" WHERE url = ANY(${keys}::text[]) AND "userId" <> ${userId}
    UNION ALL
    SELECT 1 FROM "Cosmetic" WHERE ${keyIn(`"data"->>'url'`)} = ANY(${keys}::text[])
      AND id IS DISTINCT FROM ${shopRow?.cosmeticId ?? null}::int
    UNION ALL
    SELECT 1 FROM "CosmeticShopItem" WHERE ${keyIn(`"meta"->>'coverUrl'`)} = ANY(${keys}::text[])
      AND id IS DISTINCT FROM ${shopRow?.shopItemId ?? null}::int
    UNION ALL
    SELECT 1 FROM "ItemDefinition" WHERE ${keyIn(`"imageUrl"`)} = ANY(${keys}::text[])
      AND id IS DISTINCT FROM ${shopRow?.itemDefinitionId ?? null}::int
    LIMIT 1
  `;
  if (owned.length) throw imageUrlUnavailableError();
}

/**
 * The urls among `urls` that name a key shop artwork uses. For a writer that creates `Image` rows
 * from content it does not refuse, so it can skip those instead.
 */
export async function shopArtworkUrls(urls: string[], db: Db = dbWrite): Promise<Set<string>> {
  const keysByUrl = new Map(urls.map((url) => [url, storedUrlsFor(url).slice(1)]));
  const keys = [...new Set([...keysByUrl.values()].flat())];
  if (!keys.length) return new Set();
  const used = await db.$queryRaw<{ key: string }[]>`
    SELECT k AS key FROM unnest(${keys}::text[]) k
    WHERE EXISTS (SELECT 1 FROM "Cosmetic" WHERE ${keyIn(`"data"->>'url'`)} = k)
      OR EXISTS (SELECT 1 FROM "CosmeticShopItem" WHERE ${keyIn(`"meta"->>'coverUrl'`)} = k)
      OR EXISTS (SELECT 1 FROM "ItemDefinition" WHERE ${keyIn(`"imageUrl"`)} = k)
  `;
  const usedKeys = new Set(used.map((row) => row.key));
  return new Set(urls.filter((url) => keysByUrl.get(url)?.some((key) => usedKeys.has(key))));
}
