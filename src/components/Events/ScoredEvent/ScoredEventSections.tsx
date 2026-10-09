import { Stack } from '@mantine/core';
import { useMutateEvent, useTeamColor } from '~/components/Events/events.utils';
import { EventRules } from '~/components/Events/ScoredEvent/EventRules';
import {
  MyHatsLivePoints,
  useEventTeamsLivePoints,
} from '~/components/Events/ScoredEvent/event-points-live';
import { HatCatalogPreview } from '~/components/Events/ScoredEvent/HatCatalogPreview';
import { MyEventHats } from '~/components/Events/ScoredEvent/MyEventHats';
import { ScoredEventHero } from '~/components/Events/ScoredEvent/ScoredEventHero';
import { TeamHatShelf } from '~/components/Events/ScoredEvent/TeamHatShelf';
import { TeamStandings, TopHats } from '~/components/Events/ScoredEvent/TeamStandings';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { ReactNode } from 'react';
import { Fragment } from 'react';
import type { ScoredSection } from '~/components/Events/ScoredEvent/scored-event.utils';
import { scoredSectionOrder } from '~/components/Events/ScoredEvent/scored-event.utils';

type EventData = RouterOutput['event']['getData'];

// The rank-1 team, as the end-of-event job decides it: ranks are unique, so a tie on points still
// has one winner, and the page must not announce a result the prize payout contradicts.
function winnerOf(teams?: { team: string; rank: number }[]) {
  return teams?.find((t) => t.rank === 1)?.team;
}

/**
 * The page of a scored event: what it is, where the teams stand, the viewer's hats and what they
 * earned, and the shop's event items. Everything event-specific comes from the event definition
 * (`page`, `scoring`, its decoration), so another scored event gets this page by defining one.
 */
export function ScoredEventSections({ event, data }: { event: string; data: EventData }) {
  const currentUser = useCurrentUser();
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const now = new Date();
  const ended = data.endDate < now;

  const { data: eventCosmetic } = trpc.event.getCosmetic.useQuery(
    { event },
    { enabled: !!currentUser }
  );
  const joined = !!eventCosmetic?.obtained;
  const team = joined
    ? (eventCosmetic?.cosmetic?.data as { team?: string } | undefined)?.team
    : undefined;

  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  useEventTeamsLivePoints(event);
  // Scores take late data until finalAt, and the standings snapshot is hourly: the result is final
  // only once a snapshot taken after finalAt is on the page.
  const finalizing =
    ended &&
    !!data.finalAt &&
    (now < data.finalAt || (!!standings && standings.updatedAt < data.finalAt));
  const { data: hats = [], dataUpdatedAt: hatsFetchedAt } = trpc.event.getMyHats.useQuery(
    { event },
    { enabled: joined }
  );
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
  const myStanding = team ? standings?.teams.find((t) => t.team === team) : undefined;
  const points = hats.reduce((sum, h) => sum + h.points, 0);

  const sections: Record<ScoredSection, ReactNode> = {
    standings: standings && (
      <TeamStandings standings={standings} myTeam={team} startDate={data.startDate} />
    ),
    hats: joined && hats.length > 0 && (
      <>
        <MyHatsLivePoints event={event} topicIds={hats.map((h) => h.topicId)} />
        <MyEventHats
          event={event}
          hats={hats}
          fetchedAt={hatsFetchedAt}
          teamColor={color}
          ended={ended}
        />
      </>
    ),
    shop: team ? (
      <TeamHatShelf event={event} team={team} />
    ) : (
      <HatCatalogPreview event={event} onJoin={handleJoin} joining={equipping} />
    ),
    topHats: standings && <TopHats standings={standings} />,
    rules: <EventRules data={data} />,
  };

  return (
    <Stack gap={56}>
      <ScoredEventHero
        data={data}
        team={team}
        rank={myStanding?.rank}
        teamPoints={myStanding?.score}
        points={points}
        ended={ended}
        finalizing={finalizing}
        winner={ended && !finalizing ? winnerOf(standings?.teams) : undefined}
        teamHats={standings?.teamHats}
        onJoin={handleJoin}
        joining={equipping}
      />
      {scoredSectionOrder({ joined, ended }).map((key) => (
        <Fragment key={key}>{sections[key]}</Fragment>
      ))}
    </Stack>
  );
}
