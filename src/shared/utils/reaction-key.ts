import { ReviewReactions } from '~/shared/utils/prisma/enums';

export const STICKER_REACTION_PREFIX = 'sticker:';

export type ParsedReactionKey =
  | { kind: 'builtin'; reaction: ReviewReactions }
  | { kind: 'sticker'; cosmeticId: number };

const builtinReactions = new Set<string>(Object.values(ReviewReactions));

export function formatStickerReactionKey(cosmeticId: number) {
  return `${STICKER_REACTION_PREFIX}${cosmeticId}`;
}

export function isStickerReactionKey(key: string) {
  return key.startsWith(STICKER_REACTION_PREFIX);
}

export function parseReactionKey(key: string): ParsedReactionKey | null {
  if (isStickerReactionKey(key)) {
    const raw = key.slice(STICKER_REACTION_PREFIX.length);
    if (!/^\d+$/.test(raw)) return null;
    const cosmeticId = Number(raw);
    return cosmeticId > 0 ? { kind: 'sticker', cosmeticId } : null;
  }

  return builtinReactions.has(key) ? { kind: 'builtin', reaction: key as ReviewReactions } : null;
}
