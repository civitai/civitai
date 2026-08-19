import { useCurrentUser } from '~/hooks/useCurrentUser';
import { resolveChatTheme } from '~/shared/constants/chat-theme';
import { trpc } from '~/utils/trpc';

/**
 * The theme to paint the chat window with, and whether the picker should show
 * the membership ones as available.
 */
export function useChatTheme() {
  const currentUser = useCurrentUser();
  const { data: settings } = trpc.chat.getUserSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  // The same field `RequireMembership` gates on, so a locked swatch and the
  // page it sends you to cannot disagree about who is a member. Moderators are
  // in because the whole redesign is mod-gated while it previews — the audience
  // evaluating the themes has to be able to turn one on.
  const isMember = !!currentUser?.isPaidMember || !!currentUser?.isModerator;
  const theme = resolveChatTheme(settings?.theme, isMember);

  return { theme, isMember, selectedSlug: settings?.theme };
}
