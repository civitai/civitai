import { Alert, Badge, Button, Center, Group, Loader, Skeleton, Text } from '@mantine/core';
import { IconBolt, IconBook2, IconCircleCheck, IconLock, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { StorylineFiltersDropdown } from '~/components/Storyline/StorylineFiltersDropdown';
import type { StorylineFeedFilter } from '~/components/Storyline/StorylineFiltersDropdown';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import type { RouterOutput } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type StorylineCard = RouterOutput['storyline']['getInfinite']['items'][number];

export const STORYLINE_FEED_SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'mostChapters', label: 'Most chapters' },
] as const;

type Sort = (typeof STORYLINE_FEED_SORTS)[number]['value'];

const gridClass =
  'grid list-none grid-cols-2 gap-2.5 p-0 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4';
const cardClass =
  'flex h-full flex-col overflow-hidden rounded-xl border border-solid border-gray-3 bg-gray-0 shadow-sm dark:border-dark-4 dark:bg-dark-6';
const onImageChip = '!bg-black/55 !text-white backdrop-blur-sm';

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
 * Complete storyline says so with its status chip instead.
 */
function closedLabel(storyline: StorylineCard) {
  if (storyline.open || storyline.status === 'Complete') return null;
  return storyline.whoCanContinue === 'Collaborators' ? 'Collaborators only' : 'Closed';
}

export function StorylineFeedCard({ storyline }: { storyline: StorylineCard }) {
  const complete = storyline.status === 'Complete';
  const closed = closedLabel(storyline);
  const price = storyline.open ? storyline.continuePrice : null;

  return (
    <Link href={storylineUrl(storyline.id)} className={cardClass}>
      <StorylineThumb image={storyline.coverImage} width={300} fluid className="!rounded-none">
        <Badge
          className={clsx('absolute left-2 top-2', onImageChip)}
          size="sm"
          radius="xl"
          variant="light"
          color={complete ? 'gray' : 'green'}
          leftSection={
            complete ? (
              <IconCircleCheck size={12} />
            ) : (
              <span className="block size-1.5 rounded-full bg-green-5" />
            )
          }
          data-testid="storyline-status-chip"
        >
          {storyline.status}
        </Badge>
        {closed && (
          <Badge
            className={clsx('absolute right-2 top-2', onImageChip)}
            size="sm"
            radius="xl"
            variant="light"
            color="gray"
            leftSection={<IconLock size={12} />}
            data-testid="storyline-closed-chip"
          >
            {closed}
          </Badge>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-7">
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
        <Stat icon={IconBook2} label={storyline.chapterCount === 1 ? 'chapter' : 'chapters'}>
          {storyline.chapterCount}
        </Stat>
        <Stat icon={IconUsers} label={storyline.contributorCount === 1 ? 'creator' : 'creators'}>
          {storyline.contributorCount}
        </Stat>
        {price != null && (
          <Badge
            className="ml-auto"
            size="sm"
            radius="xl"
            variant="light"
            color={price > 0 ? 'yellow' : 'green'}
            leftSection={price > 0 ? <IconBolt size={12} /> : undefined}
            data-testid="storyline-price-chip"
          >
            {price > 0 ? `${numberWithCommas(price)} to continue` : 'Free to continue'}
          </Badge>
        )}
      </div>
    </Link>
  );
}

function Stat({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof IconBook2;
  label: string;
  children: number;
}) {
  return (
    <Text
      component="span"
      size="xs"
      c="dimmed"
      className="flex items-center gap-1"
      title={`${children} ${label}`}
    >
      <Icon size={14} stroke={2} aria-hidden />
      {children}
      <span className="sr-only">{` ${label}`}</span>
    </Text>
  );
}
