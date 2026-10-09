import { Stack, Text } from '@mantine/core';
import { IconShoppingBag } from '@tabler/icons-react';
import { useMutateEvent, useTeamColor } from '~/components/Events/events.utils';
import { EventRules } from '~/components/Events/ScoredEvent/EventRules';
import { MyEventHats } from '~/components/Events/ScoredEvent/MyEventHats';
import { ScoredEventHero } from '~/components/Events/ScoredEvent/ScoredEventHero';
import { TeamHatShelf } from '~/components/Events/ScoredEvent/TeamHatShelf';
import { TeamStandings, TopHats } from '~/components/Events/ScoredEvent/TeamStandings';
import { SpotlightBorderCard } from '~/components/SpotlightCard/SpotlightBorderCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type EventData = RouterOutput['event']['getData'];

/**
 * The page of a scored event: what it is, where the teams stand, the viewer's hats and what they
 * earned, and the shop's event items. Everything event-specific comes from the event definition
 * (`page`, `scoring`, its decoration), so another scored event gets this page by defining one.
 */
export function ScoredEventSections({ event, data }: { event: string; data: EventData }) {
  const currentUser = useCurrentUser();
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const ended = data.endDate < new Date();

  const { data: eventCosmetic } = trpc.event.getCosmetic.useQuery(
    { event },
    { enabled: !!currentUser }
  );
  const joined = !!eventCosmetic?.obtained;
  const team = joined
    ? (eventCosmetic?.cosmetic?.data as { team?: string } | undefined)?.team
    : undefined;

  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  const { data: hats = [] } = trpc.event.getMyHats.useQuery({ event }, { enabled: joined });
  const { activateCosmetic, equipping } = useMutateEvent();

  const handleJoin = async () => {
    try {
      await activateCosmetic({ event });
      await utils.event.getMyHats.invalidate({ event });
    } catch (e) {
      showErrorNotification({ title: 'Unable to join', error: e as Error });
    }
  };

  const color = (team && teamColor(team)) ?? 'var(--mantine-color-blue-5)';
  const rank = team ? standings?.teams.find((t) => t.team === team)?.rank : undefined;
  const points = hats.reduce((sum, h) => sum + h.points, 0);

  return (
    <Stack gap={56}>
      <ScoredEventHero
        data={data}
        team={team}
        rank={rank}
        points={points}
        ended={ended}
        onJoin={handleJoin}
        joining={equipping}
      />

      {standings && <TeamStandings standings={standings} myTeam={team} />}

      {joined && hats.length > 0 && (
        <MyEventHats event={event} hats={hats} teamColor={color} ended={ended} />
      )}

      {!ended &&
        (team ? (
          <TeamHatShelf event={event} team={team} />
        ) : (
          <SpotlightBorderCard color="var(--mantine-color-blue-5)">
            <Stack gap={4} p="lg" align="center" ta="center">
              <IconShoppingBag size={28} />
              <Text fw={700}>Join to shop for hats</Text>
              <Text c="dimmed" size="sm">
                Hats come in your team&apos;s colour, so the shop opens once you have a team.
              </Text>
            </Stack>
          </SpotlightBorderCard>
        ))}

      {standings && <TopHats standings={standings} />}

      <EventRules data={data} />
    </Stack>
  );
}
