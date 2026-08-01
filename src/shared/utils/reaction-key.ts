import { ReviewReactions } from '~/shared/utils/prisma/enums';

export const EMOJI_REACTION_PREFIX = 'emoji:';

export type ParsedReactionKey =
  | { kind: 'builtin'; reaction: ReviewReactions }
  | { kind: 'emoji'; cosmeticId: number };

const builtinReactions = new Set<string>(Object.values(ReviewReactions));

export function formatEmojiReactionKey(cosmeticId: number) {
  return `${EMOJI_REACTION_PREFIX}${cosmeticId}`;
}

export function isEmojiReactionKey(key: string) {
  return key.startsWith(EMOJI_REACTION_PREFIX);
}

export function parseReactionKey(key: string): ParsedReactionKey | null {
  if (isEmojiReactionKey(key)) {
    const raw = key.slice(EMOJI_REACTION_PREFIX.length);
    if (!/^\d+$/.test(raw)) return null;
    const cosmeticId = Number(raw);
    return cosmeticId > 0 ? { kind: 'emoji', cosmeticId } : null;
  }

  return builtinReactions.has(key) ? { kind: 'builtin', reaction: key as ReviewReactions } : null;
}
