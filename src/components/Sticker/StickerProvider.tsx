import { createContext, useContext, useMemo } from 'react';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';

type StickerContextValue = { sticker: Map<number, ResolvedSticker>; isLoading: boolean };

const StickerContext = createContext<StickerContextValue | null>(null);

export function useStickerContext() {
  return useContext(StickerContext);
}

/**
 * Resolves every sticker a surface will render in one request. Mount it above the
 * message list, the comment thread or the reaction bar — `<Sticker>` falls back to
 * its own fetch when there's no provider, so it stays usable standalone.
 */
export function StickerProvider({ ids, children }: { ids: number[]; children: React.ReactNode }) {
  const { sticker, isLoading } = useStickerCosmetics(ids);
  const value = useMemo(() => ({ sticker, isLoading }), [sticker, isLoading]);

  return <StickerContext.Provider value={value}>{children}</StickerContext.Provider>;
}
