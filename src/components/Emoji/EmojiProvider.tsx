import { createContext, useContext, useMemo } from 'react';
import type { ResolvedEmoji } from '~/components/Emoji/emoji.util';
import { useEmojiCosmetics } from '~/components/Emoji/emoji.util';

type EmojiContextValue = { emoji: Map<number, ResolvedEmoji>; isLoading: boolean };

const EmojiContext = createContext<EmojiContextValue | null>(null);

export function useEmojiContext() {
  return useContext(EmojiContext);
}

/**
 * Resolves every emoji a surface will render in one request. Mount it above the
 * message list, the comment thread or the reaction bar — `<Emoji>` falls back to
 * its own fetch when there's no provider, so it stays usable standalone.
 */
export function EmojiProvider({ ids, children }: { ids: number[]; children: React.ReactNode }) {
  const { emoji, isLoading } = useEmojiCosmetics(ids);
  const value = useMemo(() => ({ emoji, isLoading }), [emoji, isLoading]);

  return <EmojiContext.Provider value={value}>{children}</EmojiContext.Provider>;
}
