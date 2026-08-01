export const EMOJI_SLUG_PATTERN = '[a-z0-9_]{2,32}';

const EMOJI_TOKEN = /:emoji:(\d+):/;
const EMOJI_TOKEN_OR_SLUG = new RegExp(`:emoji:\\d+:|:(${EMOJI_SLUG_PATTERN}):`, 'g');

export function isValidEmojiSlug(slug: string) {
  return new RegExp(`^${EMOJI_SLUG_PATTERN}$`).test(slug);
}

export function formatEmojiToken(cosmeticId: number) {
  return `:emoji:${cosmeticId}:`;
}

/**
 * Rewrites `:slug:` to `:emoji:<id>:` against the sender's inventory, so the
 * stored message never depends on the reader's.
 */
export function resolveEmojiTokens(content: string, resolve: (slug: string) => number | undefined) {
  return content.replace(EMOJI_TOKEN_OR_SLUG, (match, slug?: string) => {
    if (!slug) return match;
    const cosmeticId = resolve(slug);
    return cosmeticId ? formatEmojiToken(cosmeticId) : match;
  });
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
