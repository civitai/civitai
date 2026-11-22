import { maskProfanityOutsideMarkup } from '~/components/RenderHtml/mask-profanity';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getServerProfanityFilter,
  type ServerProfanityFilter,
} from '~/server/services/profanity-list.service';
import { stripStickerTokens } from '~/shared/utils/sticker-token';

/**
 * The masked copy of user text that a viewer with profanity masking on is shown in its place:
 * a string when masking changed it, `null` when it is clean. Computed for every text whatever the
 * viewer's settings, so a settings toggle needs no refetch, and at any length: long text is masked
 * in full, never blurred. `undefined` (or absent) when it was not computed: the flag is off, or
 * masking failed.
 */
export type MaskedText = string | null;

/**
 * The filter masking runs with, or `null` with `profanity-managed-list` off: then every reader
 * returns its input untouched, without building a filter or scanning a text, so the flag-off read
 * path costs and answers what it did before masking moved to the server.
 */
async function maskingFilter(): Promise<ServerProfanityFilter | null> {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.PROFANITY_MANAGED_LIST))) return null;
  return getServerProfanityFilter();
}

function maskHtml(html: string, profanity: ServerProfanityFilter): MaskedText {
  if (!html) return null;
  const masked = maskProfanityOutsideMarkup(html, profanity.filter);
  if (masked === html) return null;
  profanity.countHit('mask');
  return masked;
}

function maskChat(content: string, profanity: ServerProfanityFilter): MaskedText {
  if (!content) return null;
  const scannable = stripStickerTokens(content);
  const masked = profanity.filter.clean(scannable);
  if (masked === scannable) return null;
  profanity.countHit('mask');
  return masked;
}

/** Rich-text HTML: only the visible text is masked; tags and mentions are left as they are. */
export async function maskProfanityInHtml(htmls: string[]): Promise<(MaskedText | undefined)[]> {
  if (!htmls.length) return [];
  const profanity = await maskingFilter();
  return htmls.map((html) => (profanity ? maskHtml(html, profanity) : undefined));
}

/**
 * Chat text. Sticker tokens are removed first and the whole message is masked at once: masking
 * the runs between stickers would let a word split by one through as two clean runs. A masked
 * message is shown as flat text without its stickers.
 */
export async function maskProfanityInChat(contents: string[]): Promise<(MaskedText | undefined)[]> {
  if (!contents.length) return [];
  const profanity = await maskingFilter();
  return contents.map((content) => (profanity ? maskChat(content, profanity) : undefined));
}

/**
 * Reviews, each with `maskedDetails` beside its rich-text `details`; the input itself with the
 * flag off. Optional in the type for that, and because the browser writes reviews into its own
 * cache before the server answers.
 */
export async function withMaskedDetails<T extends { details?: string | null }>(
  reviews: T[]
): Promise<(T & { maskedDetails?: MaskedText })[]> {
  if (!reviews.length) return reviews;
  const profanity = await maskingFilter();
  if (!profanity) return reviews;
  return reviews.map((review) => ({
    ...review,
    maskedDetails: maskHtml(review.details ?? '', profanity),
  }));
}

type WithMaskedContent<M> = M extends { content: string } ? M & { maskedContent?: MaskedText } : M;

/** A chat message with its masked copy, and its quoted reply's when it has one. */
export type MaskedChatMessage<T extends { content: string; referenceMessage?: unknown }> = Omit<
  T,
  'referenceMessage'
> & { maskedContent?: MaskedText } & ('referenceMessage' extends keyof T
    ? { referenceMessage: WithMaskedContent<T['referenceMessage']> }
    : unknown);

/** Chat messages, each with `maskedContent` beside its `content`. Optional in the type as above. */
export async function withMaskedChatContent<
  T extends { content: string; referenceMessage?: { content: string } | null }
>(messages: T[]): Promise<MaskedChatMessage<T>[]> {
  if (!messages.length) return messages as MaskedChatMessage<T>[];
  const profanity = await maskingFilter();
  if (!profanity) return messages as MaskedChatMessage<T>[];
  // A quoted reply is shown too, so it carries its own copy.
  return messages.map((message) => ({
    ...message,
    maskedContent: maskChat(message.content, profanity),
    ...(message.referenceMessage
      ? {
          referenceMessage: {
            ...message.referenceMessage,
            maskedContent: maskChat(message.referenceMessage.content, profanity),
          },
        }
      : {}),
  })) as MaskedChatMessage<T>[];
}

/** Chats with their messages masked, in one masking call for all of them. */
export async function withMaskedChatPreviews<C extends { messages: { content: string }[] }>(
  chats: C[]
): Promise<(Omit<C, 'messages'> & { messages: MaskedChatMessage<C['messages'][number]>[] })[]> {
  type Message = C['messages'][number];
  const masked = await withMaskedChatContent<Message>(chats.flatMap((chat) => chat.messages));
  let offset = 0;
  return chats.map((chat) => {
    const messages = masked.slice(offset, offset + chat.messages.length);
    offset += chat.messages.length;
    return { ...chat, messages } as Omit<C, 'messages'> & {
      messages: MaskedChatMessage<Message>[];
    };
  });
}
