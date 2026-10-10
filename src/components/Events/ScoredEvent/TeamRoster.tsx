import { Alert, Loader, SegmentedControl, Switch, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTeamColor } from '~/components/Events/events.utils';
import { RosterLivePoints } from '~/components/Events/ScoredEvent/event-points-live';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/hooks/useInView';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type RosterSort = 'hats' | 'points' | 'newest';
type RosterItem = RouterOutput['event']['getTeamRoster']['items'][number];

const SORTS: { value: RosterSort; label: string }[] = [
  { value: 'hats', label: 'Most hats' },
  { value: 'points', label: 'Most points' },
  { value: 'newest', label: 'Newest' },
];
const PAGE_SIZE = 24;
// Hats a placeholder card draws before it says "+N".
const CARD_HATS = 6;

/**
 * A scored event's team rosters: one team at a time, the members who chose to be listed, as cards.
 * The cards are placeholders until the card design lands.
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
      (data?.pages.flatMap((p) => p.items) ?? []).filter(
        (i) => !(hideSelf && i.user.id === currentUser?.id)
      ),
    [data, hideSelf, currentUser?.id]
  );
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Title order={1}>Teams</Title>
        <Text c="dimmed">Members who chose to show their hats.</Text>
      </div>
      <RosterOptIn event={event} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={team}
          onChange={setTeam}
          data={teams.map((t) => ({ value: t, label: t }))}
          styles={{ indicator: { backgroundColor: teamColor(team) } }}
        />
        <SegmentedControl
          value={sort}
          onChange={(v) => setSort(v as RosterSort)}
          data={SORTS}
          size="xs"
        />
      </div>
      {!isLoading && (
        <Text size="sm" c="dimmed">
          {numberWithCommas(total)} {total === 1 ? 'member' : 'members'} listed
        </Text>
      )}
      {isLoading ? (
        <div className="flex justify-center p-8">
          <Loader />
        </div>
      ) : items.length ? (
        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @md:grid-cols-3 @lg:grid-cols-4">
          {items.map((item, i) => (
            <PlaceholderRosterCard
              key={item.user.id}
              item={item}
              rank={i + 1}
              color={teamColor(team)}
              onVisible={onVisible}
            />
          ))}
        </div>
      ) : (
        <Alert color="gray">Nobody on {team} has chosen to be listed yet.</Alert>
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

// @ai: placeholder; the card design seat replaces this with the chosen card.
function PlaceholderRosterCard({
  item,
  rank,
  color,
  onVisible,
}: {
  item: RosterItem;
  rank: number;
  color?: string;
  onVisible: (topicId: string, inView: boolean) => void;
}) {
  const { ref, inView } = useInView();
  useEffect(() => {
    onVisible(item.topicId, inView);
    return () => onVisible(item.topicId, false);
  }, [item.topicId, inView, onVisible]);
  const extra = item.hats.length - CARD_HATS;

  return (
    <div
      ref={ref}
      className="flex flex-col gap-3 rounded-lg border border-solid border-gray-3 p-3 dark:border-dark-4"
      data-testid="roster-card"
    >
      <div className="flex items-center justify-between gap-2">
        <UserAvatar user={item.user} avatarSize="sm" withUsername linkToProfile />
        <Text size="xs" c="dimmed" className="tabular-nums">
          #{rank}
        </Text>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {item.hats
          .slice(0, CARD_HATS)
          .map((hat, i) =>
            hat.url ? (
              <HatArt key={`${hat.cosmeticId}-${i}`} url={hat.url} color={color} width={96} />
            ) : null
          )}
      </div>
      <div className="flex items-center justify-between text-sm">
        <Text size="sm" fw={700} className="tabular-nums" style={{ color }}>
          {numberWithCommas(item.points)} pts
        </Text>
        <Text size="xs" c="dimmed">
          {item.hatCount} {item.hatCount === 1 ? 'hat' : 'hats'}
          {extra > 0 ? ` (+${extra} more)` : ''} · joined {formatDate(item.joinedAt)}
        </Text>
      </div>
    </div>
  );
}

/** The viewer's own listing: off until they turn it on. Only for members who joined. */
function RosterOptIn({ event }: { event: string }) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const { data: cosmetic } = trpc.event.getCosmetic.useQuery({ event }, { enabled: !!currentUser });
  const joined = !!cosmetic?.obtained;
  const { data: status } = trpc.event.getMyRosterStatus.useQuery({ event }, { enabled: joined });
  const { mutate, isPending } = trpc.event.setRosterOptIn.useMutation({
    onSuccess: async (result) => {
      utils.event.getMyRosterStatus.setData({ event }, result);
      await utils.event.getTeamRoster.invalidate();
    },
    onError: (error) => showErrorNotification({ title: 'Could not save', error }),
  });
  if (!joined) return null;

  const optedIn = status?.optedIn ?? false;
  return (
    <div className="flex flex-col gap-1">
      <Switch
        label="Show me on my team's roster"
        description="Your avatar, username, hats and points. Off by default."
        checked={optedIn}
        disabled={!status || isPending}
        onChange={(e) => mutate({ event, optIn: e.currentTarget.checked })}
      />
      {optedIn && status?.listedTeam && (
        <Text size="xs" c="dimmed">
          You&apos;re on the roster. It can take a couple of minutes to show for everyone.
        </Text>
      )}
      {optedIn && status && !status.listedTeam && (
        <Text size="xs" c="dimmed">
          Saved. You will appear once your account can earn points for your team.
        </Text>
      )}
    </div>
  );
}
