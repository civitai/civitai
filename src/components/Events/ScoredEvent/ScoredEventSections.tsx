import { Stack } from '@mantine/core';
import { useMutateEvent, useTeamColor } from '~/components/Events/events.utils';
import { EventRules } from '~/components/Events/ScoredEvent/EventRules';
import {
  MyHatsLivePoints,
  TopHatsLivePoints,
  useEventTeamsLivePoints,
} from '~/components/Events/ScoredEvent/event-points-live';
import { HatCatalogPreview } from '~/components/Events/ScoredEvent/HatCatalogPreview';
import { MyEventHats } from '~/components/Events/ScoredEvent/MyEventHats';
import { ScoredEventHero } from '~/components/Events/ScoredEvent/ScoredEventHero';
import { TeamHatShelf } from '~/components/Events/ScoredEvent/TeamHatShelf';
import { TeamStandings, TopHats } from '~/components/Events/ScoredEvent/TeamStandings';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/hooks/useInView';
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
  // Each section that shows points is live only while it is in view (event-points-live.tsx).
  const heroView = useInView();
  const standingsView = useInView();
  const hatsView = useInView();
  const topHatsView = useInView();
  // Frozen once ended: the winner the page names must be the settled one the payout uses.
  useEventTeamsLivePoints(event, !ended && (heroView.inView || standingsView.inView));
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
      <div ref={standingsView.ref}>
        <TeamStandings standings={standings} myTeam={team} startDate={data.startDate} />
      </div>
    ),
    hats: joined && hats.length > 0 && (
      <div ref={hatsView.ref}>
        <MyHatsLivePoints
          event={event}
          topicIds={hats.map((h) => h.topicId)}
          inView={hatsView.inView}
        />
        <MyEventHats
          event={event}
          hats={hats}
          fetchedAt={hatsFetchedAt}
          teamColor={color}
          ended={ended}
        />
      </div>
    ),
    shop: team ? (
      <TeamHatShelf event={event} team={team} />
    ) : (
      <HatCatalogPreview event={event} onJoin={handleJoin} joining={equipping} />
    ),
    topHats: standings && (
      <div ref={topHatsView.ref}>
        <TopHatsLivePoints
          event={event}
          topicIds={standings.topCosmetics.slice(0, 10).map((c) => c.topicId)}
          // Frozen with the team totals once ended: the page names the settled result.
          inView={topHatsView.inView && !ended}
        />
        <TopHats standings={standings} />
      </div>
    ),
    rules: <EventRules data={data} />,
  };

  return (
    <Stack gap={56}>
      <div ref={heroView.ref}>
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
      </div>
      {scoredSectionOrder({ joined, ended }).map((key) => (
        <Fragment key={key}>{sections[key]}</Fragment>
      ))}
    </Stack>
  );
}
