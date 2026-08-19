import { useCurrentUser } from '~/hooks/useCurrentUser';
import { resolveChatTheme } from '~/shared/constants/chat-theme';
import { trpc } from '~/utils/trpc';

/**
 * The theme to paint the chat window with, and whether the picker should show
 * the membership ones as available.
 */
export function useChatTheme() {
  const currentUser = useCurrentUser();
  const { data: settings } = trpc.chat.getUserSettings.useQuery();

  const isMember = !!currentUser && (currentUser.tier !== 'free' || !!currentUser.isModerator);
  const theme = resolveChatTheme(settings?.theme, isMember);

  return { theme, isMember, selectedSlug: settings?.theme };
}
