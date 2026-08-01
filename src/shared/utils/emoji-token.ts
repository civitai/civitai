export const EMOJI_SLUG_PATTERN = '[a-z0-9_]{2,32}';

const EMOJI_TOKEN = /:emoji:(\d{1,9}):/g;
// The lookahead keeps `12:30:` from reading as a slug — a slug needs a non-digit.
const EMOJI_TOKEN_OR_SLUG = new RegExp(
  `:emoji:(\\d{1,9}):|:(?![0-9]+:)(${EMOJI_SLUG_PATTERN}):`,
  'g'
);

export const EMOJI_SLUG_ERROR =
  'Emoji slugs must be 2-32 lowercase letters, numbers or underscores, and cannot be all digits';

export function isValidEmojiSlug(slug: string) {
  return new RegExp(`^${EMOJI_SLUG_PATTERN}$`).test(slug) && !/^\d+$/.test(slug);
}

export function formatEmojiToken(cosmeticId: number) {
  return `:emoji:${cosmeticId}:`;
}

export type ResolveEmojiOptions = {
  /** Maps a `:slug:` to the cosmetic id it should become. */
  resolveSlug: (slug: string) => number | undefined;
  /**
   * Server-side ownership gate. When supplied, a `:emoji:<id>:` the sender
   * doesn't own is deleted outright — neutralizing it in place would let
   * `fu:emoji:9999:ck` slip a blocked word past the content scanners.
   */
  isOwnedId?: (cosmeticId: number) => boolean;
};

export function resolveEmojiTokens(content: string, options: ResolveEmojiOptions) {
  const { resolveSlug, isOwnedId } = options;

  return content.replace(EMOJI_TOKEN_OR_SLUG, (match, tokenId?: string, slug?: string) => {
    if (slug) {
      const cosmeticId = resolveSlug(slug);
      return cosmeticId ? formatEmojiToken(cosmeticId) : match;
    }
    if (!isOwnedId) return match;
    return isOwnedId(Number(tokenId)) ? match : '';
  });
}

/** Content as the blocklists and the profanity filter should see it. */
export function stripEmojiTokens(content: string) {
  return content.replace(EMOJI_TOKEN, '');
}

export type EmojiContentPart =
  | { type: 'text'; value: string }
  | { type: 'emoji'; cosmeticId: number };

export function parseEmojiContent(content: string): EmojiContentPart[] {
  const parts: EmojiContentPart[] = [];
  const pattern = new RegExp(EMOJI_TOKEN.source, 'g');
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ type: 'text', value: content.slice(lastIndex, index) });
    parts.push({ type: 'emoji', cosmeticId: Number(match[1]) });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) parts.push({ type: 'text', value: content.slice(lastIndex) });

  return parts;
}

export function parseEmojiIds(content: string) {
  return [
    ...new Set(
      parseEmojiContent(content).flatMap((p) => (p.type === 'emoji' ? [p.cosmeticId] : []))
    ),
  ];
}
