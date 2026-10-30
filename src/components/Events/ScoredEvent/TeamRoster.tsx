import { Alert, Chip, Group, Loader, SegmentedControl, Skeleton, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTeamColor } from '~/components/Events/events.utils';
import { RosterLivePoints } from '~/components/Events/ScoredEvent/event-points-live';
import type { RosterCardContext } from '~/components/Events/ScoredEvent/roster/RosterCards';
import {
  RosterPodiumCard,
  RosterShelfCard,
} from '~/components/Events/ScoredEvent/roster/RosterCards';
import type { RosterSort } from '~/components/Events/ScoredEvent/roster/roster-cards.utils';
import {
  orderRoster,
  rosterPricePoints,
  rosterRanks,
} from '~/components/Events/ScoredEvent/roster/roster-cards.utils';
import { RosterOptIn } from '~/components/Events/ScoredEvent/roster/RosterOptIn';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const SORTS: { value: RosterSort; label: string }[] = [
  { value: 'hats', label: 'Most hats' },
  { value: 'points', label: 'Most points' },
  { value: 'newest', label: 'Newest' },
];
const PAGE_SIZE = 24;
const PODIUM_SIZE = 3;
// Wide podium order: #2, #1, #3, so the leader stands in the middle. On a phone #1 comes first.
const PODIUM_ORDER = ['@sm:order-2 @sm:-mt-4', '@sm:order-1', '@sm:order-3'];
// One or two members have no steps to stand on: a centred row in rank order, each a podium card's
// width (a third of the row less its gaps).
const SHORT_PODIUM_CARD = '@sm:w-[calc((100%-1.5rem)/3)]';

/**
 * A scored event's team rosters: one team at a time, the members who chose to be listed. The top
 * three of the sort stand on a podium of trading cards; everyone after them is a shelf card.
 */
export function TeamRoster({
  event,
  teams,
  initialTeam,
}: {
  event: string;
  teams: readonly string[];
  /** The viewer's own team, when they have one. */
  initialTeam?: string;
}) {
  const teamColor = useTeamColor();
  const [team, setTeam] = useState<string>(initialTeam ?? teams[0] ?? '');
  const [sort, setSort] = useState<RosterSort>('hats');
  useEffect(() => {
    if (initialTeam) setTeam(initialTeam);
  }, [initialTeam]);

  const input = useMemo(() => ({ event, team, sort, limit: PAGE_SIZE }), [event, team, sort]);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.event.getTeamRoster.useInfiniteQuery(input, {
      getNextPageParam: (page) => page.nextCursor,
    });
  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  // The roster is edge-cached (about 90s with stale-while-revalidate), so a refetch right after opting out can still
  // list you: your own status, read uncached, decides your own card.
  const currentUser = useCurrentUser();
  const { data: status } = trpc.event.getMyRosterStatus.useQuery(
    { event },
    { enabled: !!currentUser }
  );
  const hideSelf = !!currentUser && !!status && !status.listedTeam;
  const items = useMemo(
    () =>
      orderRoster(
        (data?.pages.flatMap((p) => p.items) ?? []).filter(
          (i) => !(hideSelf && i.user.id === currentUser?.id)
        ),
        sort
      ),
    [data, hideSelf, currentUser?.id, sort]
  );
  // Ranked after the viewer's own card is dropped, so a hidden card leaves no gap.
  const ranks = useMemo(() => rosterRanks(items, sort), [items, sort]);
  // Keyed on the prices themselves: a live push gives `items` a new identity but almost never a new
  // price, and a new array here would re-render every card through `ctx`.
  const priceKey = rosterPricePoints(items.map((i) => i.hats)).join(',');
  const prices = useMemo(() => (priceKey ? priceKey.split(',').map(Number) : []), [priceKey]);
  const total = data?.pages[0]?.total ?? 0;

  // The cards in view, whose totals are followed live.
  const [visible, setVisible] = useState<string[]>([]);
  const onVisible = useCallback((topicId: string, inView: boolean) => {
    setVisible((current) => {
      const has = current.includes(topicId);
      if (inView === has) return current;
      return inView ? [...current, topicId] : current.filter((id) => id !== topicId);
    });
  }, []);

  const [now] = useState(() => new Date());
  const color = teamColor(team);
  // Stable between renders, so a card scrolling in or out re-renders only the cards that changed.
  const ctx = useMemo<RosterCardContext>(
    () => ({
      team,
      color,
      glow: `var(--mantine-color-${team.toLowerCase()}-5)`,
      sort,
      prices,
      now,
      onVisible,
    }),
    [team, color, sort, prices, now, onVisible]
  );
  const teamHatUrl = standings?.teamHats?.find((h) => h.team === team)?.url;
  const podium = items.slice(0, PODIUM_SIZE);
  const grid = items.slice(PODIUM_SIZE);
  const fullPodium = podium.length === PODIUM_SIZE;

  return (
    <div className="flex flex-col gap-4 @container">
      <div className="flex flex-col gap-1">
        <Title order={1}>Teams</Title>
        <Text c="dimmed">Members who chose to show their hats.</Text>
      </div>
      <RosterOptIn event={event} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chip.Group multiple={false} value={team} onChange={setTeam}>
          <Group gap="xs">
            {teams.map((t) => (
              <Chip key={t} value={t} color={t.toLowerCase()} variant="light" radius="xl">
                {t}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <SegmentedControl
          value={sort}
          onChange={(v) => setSort(v as RosterSort)}
          data={SORTS}
          size="xs"
          radius="xl"
        />
      </div>
      {!isLoading && (
        <Text size="sm" c="dimmed">
          {numberWithCommas(total)} {total === 1 ? 'member' : 'members'} listed
        </Text>
      )}
      {isLoading ? (
        <RosterSkeleton />
      ) : items.length ? (
        <>
          <div
            className={clsx(
              'grid grid-cols-2 items-stretch gap-3',
              fullPodium ? '@sm:grid-cols-3 @sm:pt-4' : '@sm:flex @sm:justify-center'
            )}
            data-testid="roster-podium"
          >
            {podium.map((item, i) => (
              <RosterPodiumCard
                key={item.user.id}
                item={item}
                rank={ranks[i]}
                ctx={ctx}
                teamHatUrl={teamHatUrl}
                className={
                  fullPodium
                    ? clsx(PODIUM_ORDER[i], i === 0 && 'col-span-2 @sm:col-span-1')
                    : clsx(SHORT_PODIUM_CARD, podium.length === 1 && 'col-span-2')
                }
              />
            ))}
          </div>
          {grid.length > 0 && (
            <div
              className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]"
              data-testid="roster-grid"
            >
              {grid.map((item, i) => (
                <RosterShelfCard
                  key={item.user.id}
                  item={item}
                  rank={ranks[i + PODIUM_SIZE]}
                  ctx={ctx}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <Alert color="gray">
          No one on Team {team} has opted in to the roster yet. The roster only shows members who
          turn on &ldquo;Show me on my team&apos;s roster&rdquo;.
          {team === initialTeam && status && !status.optedIn && (
            <> Turn it on above to be the first.</>
          )}
        </Alert>
      )}
      {hasNextPage && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
          <div className="flex justify-center p-4">
            <Loader size="sm" />
          </div>
        </InViewLoader>
      )}
      <RosterLivePoints event={event} input={input} topicIds={visible} />
    </div>
  );
}

function RosterSkeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="roster-loading">
      <div className="grid grid-cols-2 gap-3 @sm:grid-cols-3">
        {Array.from({ length: PODIUM_SIZE }, (_, i) => (
          <Skeleton
            key={i}
            h={380}
            radius="md"
            className={clsx(i === 0 && 'col-span-2 @sm:col-span-1')}
          />
        ))}
      </div>
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} h={260} radius="md" />
        ))}
      </div>
    </div>
  );
}
