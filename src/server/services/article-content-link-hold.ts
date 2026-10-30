import { registerCounterWithLabels } from '~/server/prom/client';
import { keyIssuers, keysIn } from '~/server/services/image-url-ownership';

/**
 * Content urls with no `Image` row that linking may not create one for yet. An article holding any
 * stays off public until each settles: `deferred` until its key's issuer can be read, `refused`
 * while its key was issued to someone other than the owner or the editor.
 */
export type ContentLinkHold = {
  deferred: string[];
  refused: string[];
  /** Who saved the content; their own keys count as the owner's. */
  editorId?: number;
  /** When a url was first deferred, kept while any stays deferred. */
  deferredSince?: string;
  /** Set once a deferral outlives the backstop and a moderator report is filed. */
  reportedAt?: string;
};

const HOLD_KEY = 'contentLinkHold';
/** Each issuer lookup takes a bounded number of keys; an article can hold more images than that. */
const URLS_PER_LOOKUP = 16;

export const contentLinkHoldCounter = registerCounterWithLabels({
  name: 'article_content_link_hold_total',
  help: 'Article content urls held from linking: deferred, refused, settled, reported.',
  labelNames: ['outcome'] as const,
});

export function readContentLinkHold(metadata: unknown): ContentLinkHold | null {
  const hold = (metadata as Record<string, unknown> | null)?.[HOLD_KEY] as
    | ContentLinkHold
    | undefined;
  if (!hold || (!hold.deferred?.length && !hold.refused?.length)) return null;
  return { ...hold, deferred: hold.deferred ?? [], refused: hold.refused ?? [] };
}

/** `metadata` with `hold` in place of the current one, or with none when `hold` holds no url. */
export function withContentLinkHold(metadata: unknown, hold: ContentLinkHold | null) {
  const { [HOLD_KEY]: _, ...rest } = (metadata as Record<string, unknown> | null) ?? {};
  return hold && (hold.deferred.length || hold.refused.length)
    ? { ...rest, [HOLD_KEY]: hold }
    : rest;
}

/**
 * Sorts `urls` (content urls with no `Image` row) by what their keys' issue records say: issued to
 * someone other than `ownerId` and `editorId` is refused; unresolved while the upload request log
 * could not be read is deferred. The rest may be linked.
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
    const unresolved = new Set(issuers.requestLogReadFailed ? issuers.unrecorded : []);
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
  now = new Date()
): ContentLinkHold | null {
  if (!refused.length && !deferred.length) return null;
  const stillDeferred = deferred.length > 0 && !!previous?.deferred.length;
  return {
    deferred,
    refused,
    editorId,
    ...(deferred.length
      ? { deferredSince: (stillDeferred && previous?.deferredSince) || now.toISOString() }
      : {}),
    ...(stillDeferred && previous?.reportedAt ? { reportedAt: previous.reportedAt } : {}),
  };
}
