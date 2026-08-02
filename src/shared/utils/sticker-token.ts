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

/**
 * Stickers render height-driven — the sizes above are heights, and width follows
 * the artwork. This caps how wide one may get, in either orientation, so a
 * sticker stays a sticker rather than becoming a banner. Enforced at upload by
 * `cosmeticImageRequirements` and again as a `max-width` at render.
 */
export const STICKER_MAX_ASPECT_RATIO = 2;

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

/**
 * Placements per sticker id. A *use* is one placement, not one message: three
 * stickers in a comment is three uses, and the same sticker twice is two.
 *
 * Counts both content forms, since chat stores `:sticker:<id>:` tokens while
 * comments store `<span data-type="sticker" data-id="…">` — a given piece of
 * content is one or the other, so scanning for both is safe.
 */
export type StickerContentForm = 'token' | 'span';

/**
 * Placements per sticker id. A *use* is one placement, not one message: three
 * stickers in a comment is three uses, and the same sticker twice is two.
 *
 * The form is explicit because the two surfaces store differently and only
 * render their own: chat stores `:sticker:<id>:` tokens, comments store
 * `<span data-type="sticker">`. Scanning for both would charge a comment for
 * literal `:sticker:12:` text — which comments render as plain text, and which
 * arrives easily by pasting a chat message in.
 */
export function countStickerPlacements(
  content: string,
  form: StickerContentForm
): Map<number, number> {
  const counts = new Map<number, number>();
  const add = (raw: string) => {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };

  if (form === 'token')
    for (const match of content.matchAll(new RegExp(STICKER_TOKEN.source, 'g'))) add(match[1]);
  else
    for (const match of content.matchAll(
      /<span[^>]*data-type="sticker"[^>]*data-id="(\d{1,9})"[^>]*>|<span[^>]*data-id="(\d{1,9})"[^>]*data-type="sticker"[^>]*>/g
    ))
      add(match[1] ?? match[2]);

  return counts;
}

export function netNewStickerPlacements(
  nextContent: string,
  prevContent = '',
  form: StickerContentForm = 'span'
): Map<number, number> {
  const next = countStickerPlacements(nextContent, form);
  const prev = countStickerPlacements(prevContent, form);
  const delta = new Map<number, number>();

  for (const [id, count] of next) {
    const added = count - (prev.get(id) ?? 0);
    if (added > 0) delta.set(id, added);
  }

  return delta;
}

export type StickerSurface = 'chat' | 'comment';

/**
 * Everything that varies per surface, in one table.
 *
 * These three facts are the same decision seen from different sides, and they
 * were previously spread across the sanitizer opt-in, a CONSUMES map and a
 * CONTENT_FORM map. Splitting them let content be *containable* somewhere that
 * never charged — which is how sticker markup ended up free on ~30 rich-text
 * surfaces. A surface not listed here is denied by default everywhere.
 */
export const STICKER_SURFACES = {
  // Free and unlimited by decision (§4b.3), so it stores tokens and never charges.
  chat: { form: 'token', consumes: false, label: 'direct messages' },
  comment: { form: 'span', consumes: true, label: 'comments' },
} as const satisfies Record<
  StickerSurface,
  { form: StickerContentForm; consumes: boolean; label: string }
>;

/** Whether a surface may hold sticker markup at all. Anything absent is denied. */
export const surfaceMayContainStickers = (surface: string): boolean => surface in STICKER_SURFACES;

/**
 * Where stickers cost a use and where they don't, in words, read from the table
 * above. Copy that names surfaces by hand goes stale the moment the table
 * changes — and worse, can promise a surface stickers were deliberately denied.
 */
export const stickerSurfaceLabels = () => {
  const surfaces = Object.values(STICKER_SURFACES);
  return {
    charged: surfaces.filter((s) => s.consumes).map((s) => s.label),
    free: surfaces.filter((s) => !s.consumes).map((s) => s.label),
  };
};

/** `data.uses` when it is a usable positive integer, else null (= unlimited). */
export const stickerUsesFromCosmeticData = (data: unknown) => {
  const uses = (data as { uses?: unknown } | null | undefined)?.uses;
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : null;
};

/** How many uses of their own sticker a creator gets when it is approved. */
export const CREATOR_GRANT_USES_MULTIPLIER = 10;
