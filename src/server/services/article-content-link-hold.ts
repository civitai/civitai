import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import {
  imageUrlUnavailableError,
  keyIssuers,
  keysIn,
} from '~/server/services/image-url-ownership';

/**
 * Content urls with no `Image` row that linking may not create one for yet (the
 * `ArticleContentLinkHold` row). An article holding any stays off public until each settles:
 * `deferred` until its key's issuer can be read, `refused` while it is someone other than the
 * owner or the editor.
 */
export type ContentLinkHold = {
  deferred: string[];
  refused: string[];
  editorId: number;
  deferredSince: Date | null;
  reportedAt: Date | null;
};

/** Each issuer lookup takes a bounded number of keys; an article can hold more images than that. */
const URLS_PER_LOOKUP = 16;

export const contentLinkHoldCounter = registerCounterWithLabels({
  name: 'article_content_link_hold_total',
  help: 'Article content urls held from linking: deferred, refused, settled, reported, unavailable.',
  labelNames: ['outcome'] as const,
});

type HoldDb = Pick<Prisma.TransactionClient, 'articleContentLinkHold'>;

/** Refuses, with the generic refusal, when the hold cannot be read: such a url must never link. */
export async function assertContentLinkHoldWritable(db: HoldDb = dbWrite) {
  try {
    await db.articleContentLinkHold.findFirst({ select: { articleId: true } });
  } catch {
    contentLinkHoldCounter.inc({ outcome: 'unavailable' });
    throw imageUrlUnavailableError();
  }
}

export async function getContentLinkHold(
  db: HoldDb,
  articleId: number
): Promise<ContentLinkHold | null> {
  return db.articleContentLinkHold.findUnique({
    where: { articleId },
    select: {
      deferred: true,
      refused: true,
      editorId: true,
      deferredSince: true,
      reportedAt: true,
    },
  });
}

/**
 * Sorts `urls` (content urls with no `Image` row) by what their keys' issue records say: issued to
 * someone other than `ownerId` and `editorId` is refused; unresolved while either issue store could
 * not be read is deferred. The rest may be linked.
 */
export async function classifyUnlinkedContentUrls({
  urls,
  ownerId,
  editorId,
}: {
  urls: string[];
  ownerId: number;
  editorId: number;
}) {
  const refused: string[] = [];
  const deferred: string[] = [];
  for (let i = 0; i < urls.length; i += URLS_PER_LOOKUP) {
    const chunk = urls.slice(i, i + URLS_PER_LOOKUP);
    const issuers = await keyIssuers({ urls: chunk, userId: ownerId, alsoIssuedTo: editorId });
    if (issuers.tooMany) {
      refused.push(...chunk);
      continue;
    }
    const others = new Set(issuers.issuedToOthers);
    // Some keys are recorded only in the issue record, so either store failing leaves them unproved.
    const lookupFailed = issuers.requestLogReadFailed || issuers.recordReadFailed;
    const unresolved = new Set(lookupFailed ? issuers.unrecorded : []);
    for (const url of chunk) {
      const keys = keysIn(url);
      if (keys.some((key) => others.has(key))) refused.push(url);
      else if (keys.some((key) => unresolved.has(key))) deferred.push(url);
    }
  }
  return { refused, deferred };
}

/** The hold to store after linking found `refused` and `deferred`, carrying over what still applies. */
export function nextContentLinkHold(
  previous: ContentLinkHold | null,
  { refused, deferred, editorId }: { refused: string[]; deferred: string[]; editorId: number },
  now: Date
): ContentLinkHold | null {
  if (!refused.length && !deferred.length) return null;
  const stillDeferred = deferred.length > 0 && !!previous?.deferred.length;
  return {
    deferred,
    refused,
    editorId,
    deferredSince: deferred.length ? (stillDeferred && previous?.deferredSince) || now : null,
    reportedAt: (stillDeferred && previous?.reportedAt) || null,
  };
}

/** A timestamp(3) column holds UTC; a bare Date would be read in the session's time zone. */
const utc = (date: Date | null) =>
  date ? Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')` : Prisma.sql`NULL`;

const sorted = (urls: string[]) => [...urls].sort().join('\n');
const time = (date: Date | null) => date?.getTime() ?? null;

export function sameContentLinkHold(a: ContentLinkHold | null, b: ContentLinkHold | null) {
  if (!a || !b) return a === b;
  return (
    sorted(a.deferred) === sorted(b.deferred) &&
    sorted(a.refused) === sorted(b.refused) &&
    a.editorId === b.editorId &&
    time(a.deferredSince) === time(b.deferredSince) &&
    time(a.reportedAt) === time(b.reportedAt)
  );
}

/**
 * Stores `hold` for `articleId`, or clears it, only while the article still holds `content`: a link
 * run over content a later save replaced must not overwrite that save's hold. Returns whether it
 * wrote.
 */
export async function writeContentLinkHold(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  { articleId, content, hold }: { articleId: number; content: string; hold: ContentLinkHold | null }
) {
  const written = hold
    ? await db.$executeRaw`
        INSERT INTO "ArticleContentLinkHold"
          ("articleId", deferred, refused, "editorId", "deferredSince", "reportedAt", "checkedAt")
        SELECT a.id, ${hold.deferred}::text[], ${hold.refused}::text[], ${hold.editorId}::int,
          ${utc(hold.deferredSince)}, ${utc(hold.reportedAt)}, now()
        FROM "Article" a
        WHERE a.id = ${articleId} AND md5(COALESCE(a.content, '')) = md5(${content})
        ON CONFLICT ("articleId") DO UPDATE SET
          deferred = EXCLUDED.deferred, refused = EXCLUDED.refused,
          "editorId" = EXCLUDED."editorId", "deferredSince" = EXCLUDED."deferredSince",
          "reportedAt" = EXCLUDED."reportedAt"
      `
    : await db.$executeRaw`
        DELETE FROM "ArticleContentLinkHold" h
        USING "Article" a
        WHERE h."articleId" = ${articleId} AND a.id = h."articleId"
          AND md5(COALESCE(a.content, '')) = md5(${content})
      `;
  return written > 0;
}
