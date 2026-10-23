import { Alert, Button, Center, Group, Loader, Skeleton, Text } from '@mantine/core';
import { IconBook2, IconUsers } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { storylineUrl, storylineWriteChapterUrl } from '~/components/Storyline/storyline-routes';
import { StorylineFiltersDropdown } from '~/components/Storyline/StorylineFiltersDropdown';
import type { StorylineFeedFilter } from '~/components/Storyline/StorylineFiltersDropdown';
import {
  StorylineClosedChip,
  StorylinePriceChip,
  StorylineStat,
  StorylineStatusChip,
  storylineCardClass,
} from '~/components/Storyline/StorylineChips';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

type StorylineCard = RouterOutput['storyline']['getInfinite']['items'][number];

export const STORYLINE_FEED_SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'mostChapters', label: 'Most chapters' },
] as const;

type Sort = (typeof STORYLINE_FEED_SORTS)[number]['value'];

const gridClass =
  'grid list-none grid-cols-2 gap-2.5 p-0 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4';
const cardClass = `flex h-full flex-col overflow-hidden ${storylineCardClass}`;

export function StorylinesFeed() {
  const [filter, setFilter] = useState<StorylineFeedFilter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetching } =
    trpc.storyline.getInfinite.useInfiniteQuery(
      { filter, sort, limit: 24, browsingLevel },
      { getNextPageParam: (last) => last.nextCursor }
    );
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  return (
    <div className="flex flex-col gap-4">
      <Group justify="space-between" align="center" gap="xs">
        <Text fz={22} fw={800}>
          Discover storylines
        </Text>
        <Group gap={8} wrap="nowrap">
          <SelectMenuV2
            label={STORYLINE_FEED_SORTS.find((s) => s.value === sort)?.label ?? sort}
            value={sort}
            onClick={setSort}
            options={[...STORYLINE_FEED_SORTS]}
          />
          <StorylineFiltersDropdown value={filter} onChange={setFilter} />
        </Group>
      </Group>

      {isLoading ? (
        <ul className={gridClass} aria-busy data-testid="storylines-feed-skeleton">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className={cardClass}>
              <Skeleton className="aspect-[3/4] w-full" radius={0} />
              <div className="flex flex-col gap-2 p-3">
                <Skeleton height={10} width="70%" />
                <Skeleton height={10} width="40%" />
              </div>
            </li>
          ))}
        </ul>
      ) : isError && !items.length ? (
        <Alert color="red" title="Couldn't load storylines">
          <Button size="xs" variant="light" color="red" onClick={() => refetch()}>
            Try again
          </Button>
        </Alert>
      ) : !items.length ? (
        <NoContent message="No storylines match." />
      ) : (
        <>
          <ul className={gridClass}>
            {items.map((item) => (
              <li key={item.id}>
                <StorylineFeedCard storyline={item} />
              </li>
            ))}
          </ul>
          {hasNextPage ? (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
              <Center p="md">
                <Loader type="dots" />
              </Center>
            </InViewLoader>
          ) : (
            <EndOfFeed />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Why this reader cannot continue a storyline that is still going, or null when they can. A
 * Complete storyline says so with its status chip instead. Collaborators only never shuts out
 * the owner, so when it is closed to them it is simply Closed.
 */
function closedLabel(storyline: StorylineCard, viewerId: number | undefined) {
  if (storyline.open || storyline.status === 'Complete') return null;
  const isOwner = viewerId != null && viewerId === storyline.user.id;
  return storyline.whoCanContinue === 'Collaborators' && !isOwner ? 'Collaborators only' : 'Closed';
}

export function StorylineFeedCard({ storyline }: { storyline: StorylineCard }) {
  const currentUser = useCurrentUser();
  const closed = closedLabel(storyline, currentUser?.id);
  const price = storyline.open ? storyline.continuePrice : null;

  const thumb = (
    <StorylineThumb image={storyline.coverImage} width={300} fluid className="!rounded-none">
      <StorylineStatusChip status={storyline.status} onImage className="absolute left-2 top-2" />
      {closed && <StorylineClosedChip label={closed} onImage className="absolute right-2 top-2" />}
      <div className="absolute inset-x-0 bottom-0 flex h-[45%] flex-col justify-end bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
        <Text fz={17} fw={800} lh={1.2} c="white" lineClamp={2}>
          {storyline.title}
        </Text>
        {storyline.user.username && (
          <Text size="xs" className="mt-1 text-white/85">
            by {storyline.user.username}
          </Text>
        )}
      </div>
    </StorylineThumb>
  );

  // Only its owner is shown a storyline with no chapter 1 yet, and what they do next is write it.
  if (storyline.chapterCount === 0 && storyline.user.id === currentUser?.id)
    return (
      <div className={cardClass}>
        <Link href={storylineUrl(storyline.id)}>{thumb}</Link>
        <div className="flex flex-1 flex-col gap-2 px-3 py-2.5">
          <Text size="sm" c="dimmed">
            No chapter 1 yet
          </Text>
          <Button
            component={Link}
            href={storylineWriteChapterUrl(storyline.id)}
            color="violet"
            size="xs"
            fullWidth
          >
            Write chapter 1
          </Button>
        </div>
      </div>
    );

  return (
    <Link href={storylineUrl(storyline.id)} className={cardClass}>
      {thumb}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
        <StorylineStat
          icon={IconBook2}
          count={storyline.chapterCount}
          one="chapter"
          many="chapters"
        />
        <StorylineStat
          icon={IconUsers}
          count={storyline.contributorCount}
          one="creator"
          many="creators"
        />
        {price != null && <StorylinePriceChip price={price} short className="ml-auto" />}
      </div>
    </Link>
  );
}
