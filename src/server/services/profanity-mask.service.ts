import { maskProfanityOutsideMarkup } from '~/components/RenderHtml/mask-profanity';
import { getServerProfanityFilter } from '~/server/services/profanity-list.service';
import { stripStickerTokens } from '~/shared/utils/sticker-token';

/**
 * The masked copy of user text that a viewer with profanity masking on is shown in its place:
 * a string when masking changed it, `null` when it is clean. Computed for every text whatever the
 * viewer's settings, so a settings toggle needs no refetch, and at any length (Justin, J6: long
 * text is masked as it is today, never blurred).
 */
export type MaskedText = string | null;

/** Rich-text HTML: only the visible text is masked; tags and mentions are left as they are. */
export async function maskProfanityInHtml(htmls: string[]): Promise<MaskedText[]> {
  if (!htmls.length) return [];
  const profanity = await getServerProfanityFilter();
  return htmls.map((html) => {
    if (!html) return null;
    const masked = maskProfanityOutsideMarkup(html, profanity.filter);
    if (masked === html) return null;
    profanity.countHit('mask');
    return masked;
  });
}

/**
 * Chat text. Sticker tokens are removed first and the whole message is masked at once: masking
 * the runs between stickers would let a word split by one through as two clean runs. A masked
 * message is shown as flat text without its stickers.
 */
export async function maskProfanityInChat(contents: string[]): Promise<MaskedText[]> {
  if (!contents.length) return [];
  const profanity = await getServerProfanityFilter();
  return contents.map((content) => {
    if (!content) return null;
    const scannable = stripStickerTokens(content);
    const masked = profanity.filter.clean(scannable);
    if (masked === scannable) return null;
    profanity.countHit('mask');
    return masked;
  });
}

/**
 * Reviews, each with `maskedDetails` beside its rich-text `details`. Always set here; optional in
 * the type only because the browser writes reviews into its own cache before the server answers.
 */
export async function withMaskedDetails<T extends { details?: string | null }>(
  reviews: T[]
): Promise<(T & { maskedDetails?: MaskedText })[]> {
  const masked = await maskProfanityInHtml(reviews.map((review) => review.details ?? ''));
  return reviews.map((review, i) => ({ ...review, maskedDetails: masked[i] }));
}

/** Chat messages, each with `maskedContent` beside its `content`. Optional in the type as above. */
export async function withMaskedChatContent<T extends { content: string }>(
  messages: T[]
): Promise<(T & { maskedContent?: MaskedText })[]> {
  const masked = await maskProfanityInChat(messages.map((message) => message.content));
  return messages.map((message, i) => ({ ...message, maskedContent: masked[i] }));
}
