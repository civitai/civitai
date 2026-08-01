export const STICKER_SLUG_PATTERN = '[a-z0-9_]{2,32}';

// `:emoji:` is the pre-rename form. It is still read so anything already sent
// keeps rendering; only `:sticker:` is ever written.
const TOKEN_KEYWORD = '(?:sticker|emoji)';
const STICKER_TOKEN = new RegExp(`:${TOKEN_KEYWORD}:(\\d{1,9}):`, 'g');
// The lookahead keeps `12:30:` from reading as a slug — a slug needs a non-digit.
const STICKER_TOKEN_OR_SLUG = new RegExp(
  `:${TOKEN_KEYWORD}:(\\d{1,9}):|:(?![0-9]+:)(${STICKER_SLUG_PATTERN}):`,
  'g'
);

export const STICKER_SLUG_ERROR =
  'Sticker slugs must be 2-32 lowercase letters, numbers or underscores, and cannot be all digits';

export function isValidStickerSlug(slug: string) {
  return new RegExp(`^${STICKER_SLUG_PATTERN}$`).test(slug) && !/^\d+$/.test(slug);
}

export function formatStickerToken(cosmeticId: number) {
  return `:sticker:${cosmeticId}:`;
}

export type ResolveStickerOptions = {
  /** Maps a `:slug:` to the cosmetic id it should become. */
  resolveSlug: (slug: string) => number | undefined;
  /**
   * Server-side ownership gate. When supplied, a `:sticker:<id>:` the sender
   * doesn't own is deleted outright — neutralizing it in place would let
   * `fu:sticker:9999:ck` slip a blocked word past the content scanners.
   */
  isOwnedId?: (cosmeticId: number) => boolean;
};

export function resolveStickerTokens(content: string, options: ResolveStickerOptions) {
  const { resolveSlug, isOwnedId } = options;

  return content.replace(STICKER_TOKEN_OR_SLUG, (match, tokenId?: string, slug?: string) => {
    if (slug) {
      const cosmeticId = resolveSlug(slug);
      return cosmeticId ? formatStickerToken(cosmeticId) : match;
    }
    if (!isOwnedId) return match;
    // Re-emit owned tokens in the current form, so a legacy `:emoji:` that
    // passes the ownership check is normalized on the way through.
    return isOwnedId(Number(tokenId)) ? formatStickerToken(Number(tokenId)) : '';
  });
}

/** Content as the blocklists and the profanity filter should see it. */
export function stripStickerTokens(content: string) {
  return content.replace(STICKER_TOKEN, '');
}

export type StickerContentPart =
  | { type: 'text'; value: string }
  | { type: 'sticker'; cosmeticId: number };

export function parseStickerContent(content: string): StickerContentPart[] {
  const parts: StickerContentPart[] = [];
  const pattern = new RegExp(STICKER_TOKEN.source, 'g');
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ type: 'text', value: content.slice(lastIndex, index) });
    parts.push({ type: 'sticker', cosmeticId: Number(match[1]) });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) parts.push({ type: 'text', value: content.slice(lastIndex) });

  return parts;
}

export const STICKER_SIZE = {
  /** A line of nothing but sticker. */
  jumbo: 48,
  /** Sticker sitting alongside text, aligned to the line. */
  inline: 22,
  /** Reply quotes and list previews — a summary surface, never jumbo. */
  preview: 16,
} as const;

/** Past this many on one line, jumbo becomes a wall of images. */
export const STICKER_JUMBO_LIMIT = 6;

export type StickerLine = { parts: StickerContentPart[]; jumbo: boolean };

/**
 * Splits content into lines and decides per line whether its sticker render
 * jumbo. Shared so chat and comments can't drift on the rule.
 */
export function parseStickerLines(content: string): StickerLine[] {
  return content.split('\n').map((line) => {
    const parts = parseStickerContent(line);
    const stickerCount = parts.filter((p) => p.type === 'sticker').length;
    const textIsBlank = parts.every((p) => p.type !== 'text' || !p.value.trim());

    return { parts, jumbo: textIsBlank && stickerCount > 0 && stickerCount <= STICKER_JUMBO_LIMIT };
  });
}

export function parseStickerIds(content: string) {
  return [
    ...new Set(
      parseStickerContent(content).flatMap((p) => (p.type === 'sticker' ? [p.cosmeticId] : []))
    ),
  ];
}
