import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';

/** Shown when a client-supplied image url cannot be used. Keep it actionable. */
export const COVER_IMAGE_UNAVAILABLE_MESSAGE =
  'This cover image is no longer available. Please re-upload it.';

export const imageUrlUnavailableError = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: COVER_IMAGE_UNAVAILABLE_MESSAGE });

type Db = Prisma.TransactionClient | typeof dbWrite;

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
  // Whatever the other row's state.
  const owned = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image" WHERE url = ANY(${keys}::text[]) AND "userId" <> ${userId} LIMIT 1
  `;
  if (owned.length) throw imageUrlUnavailableError();
}
