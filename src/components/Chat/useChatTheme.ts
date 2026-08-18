import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';
import { resolveChatTheme } from '~/shared/constants/chat-theme';
import { trpc } from '~/utils/trpc';

/**
 * The theme to paint the chat window with, and the entitlement the picker needs
 * to know what is locked.
 */
export function useChatTheme() {
  const { data: settings } = trpc.chat.getUserSettings.useQuery();
  const { data: cosmetics } = useQueryUserCosmetics();

  const ownedSlugs = useMemo(
    () => (cosmetics?.chatTheme ?? []).map((x) => x.data?.slug).filter((x): x is string => !!x),
    [cosmetics?.chatTheme]
  );

  const theme = resolveChatTheme(settings?.theme, ownedSlugs);

  return { theme, ownedSlugs, selectedSlug: settings?.theme };
}
