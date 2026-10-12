import { Switch, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Saves the viewer's roster choice and refreshes what shows it. */
export function useSetRosterOptIn(event: string) {
  const utils = trpc.useUtils();
  return trpc.event.setRosterOptIn.useMutation({
    onSuccess: async (result) => {
      utils.event.getMyRosterStatus.setData({ event }, result);
      await utils.event.getTeamRoster.invalidate();
    },
    onError: (error) => showErrorNotification({ title: 'Could not save', error }),
  });
}

/**
 * The viewer's own listing: off until they turn it on. Only for members who joined. `compact` is the
 * one-line form for the joined panel on the event page.
 */
export function RosterOptIn({ event, compact }: { event: string; compact?: boolean }) {
  const currentUser = useCurrentUser();
  const { data: cosmetic } = trpc.event.getCosmetic.useQuery({ event }, { enabled: !!currentUser });
  const joined = !!cosmetic?.obtained;
  const { data: status } = trpc.event.getMyRosterStatus.useQuery({ event }, { enabled: joined });
  const { mutate, isPending } = useSetRosterOptIn(event);
  if (!joined) return null;

  const optedIn = status?.optedIn ?? false;
  return (
    <div className="flex flex-col gap-1">
      <Switch
        size={compact ? 'xs' : 'sm'}
        label="Show me on my team's roster"
        description={
          compact ? undefined : 'Your avatar, username, hats and points. Off by default.'
        }
        checked={optedIn}
        disabled={!status || isPending}
        onChange={(e) => mutate({ event, optIn: e.currentTarget.checked })}
        data-testid="roster-opt-in"
      />
      {!compact && optedIn && status?.listedTeam && (
        <Text size="xs" c="dimmed">
          You&apos;re on the roster. It can take a couple of minutes to show for everyone.
        </Text>
      )}
      {!compact && optedIn && status && !status.listedTeam && (
        <Text size="xs" c="dimmed">
          Saved. You will appear once your account can earn points for your team.
        </Text>
      )}
    </div>
  );
}
