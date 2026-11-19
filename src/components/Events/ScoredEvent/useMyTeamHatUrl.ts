import { isShowcaseHatShowing } from '~/components/Cosmetics/EventDecoration/AvatarHat';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * The hat for the viewer's own "You're on Team X" panel: the one their avatar shows (their pick, else
 * the roster's lead hat), else `teamCap`. Undefined while that is still loading, so the team cap never
 * flashes before the showcase hat.
 */
export function useMyTeamHatUrl(event: string, team: string | undefined, teamCap?: string | null) {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.event.getMyShowcaseHatArt.useQuery(
    { event },
    { enabled: !!currentUser && !!team }
  );
  if (!team || isLoading) return undefined;
  return isShowcaseHatShowing(data) ? data.url : teamCap ?? undefined;
}
