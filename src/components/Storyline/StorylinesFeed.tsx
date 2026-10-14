import {
  Alert,
  Badge,
  Button,
  Center,
  Loader,
  SegmentedControl,
  Select,
  Text,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

type StorylineCard = RouterOutput['storyline']['getInfinite']['items'][number];
type CoverImage = ReturnType<typeof useQueryImages>['images'][number];

export const STORYLINE_FEED_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'open', label: 'Open for continuations' },
  { value: 'complete', label: 'Complete' },
] as const;
export const STORYLINE_FEED_SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'mostChapters', label: 'Most chapters' },
] as const;

type Filter = (typeof STORYLINE_FEED_FILTERS)[number]['value'];
type Sort = (typeof STORYLINE_FEED_SORTS)[number]['value'];

/** Each storyline's cover is the first image of its chapter 1, read for the whole page at once. */
function useCovers(items: StorylineCard[], browsingLevel: number) {
  const postIds = useMemo(
    () => items.flatMap((item) => (item.rootPostId ? [item.rootPostId] : [])),
    [items]
  );
  const { images } = useQueryImages(
    { postIds, browsingLevel, limit: 200, withMeta: false, include: [] },
    { enabled: postIds.length > 0 }
  );
  return useMemo(() => {
    const byPost = new Map<number, CoverImage>();
    for (const image of images) {
      if (image.postId == null) continue;
      const current = byPost.get(image.postId);
      if (!current || (image.index ?? 0) < (current.index ?? 0)) byPost.set(image.postId, image);
    }
    return byPost;
  }, [images]);
}

export function StorylinesFeed() {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  // The same level the covers are read at, so the list and its covers cannot disagree.
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetching } =
    trpc.storyline.getInfinite.useInfiniteQuery(
      { filter, sort, limit: 24, browsingLevel },
      { getNextPageParam: (last) => last.nextCursor }
    );
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const covers = useCovers(items, browsingLevel);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label="Show"
          value={filter}
          onChange={(value) => setFilter(value as Filter)}
          data={STORYLINE_FEED_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
        />
        <Select
          aria-label="Sort"
          w={180}
          allowDeselect={false}
          value={sort}
          onChange={(value) => value && setSort(value as Sort)}
          data={STORYLINE_FEED_SORTS.map((s) => ({ value: s.value, label: s.label }))}
        />
      </div>

      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
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
          <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-0">
            {items.map((item) => (
              <li key={item.id}>
                <StorylineFeedCard
                  storyline={item}
                  cover={item.rootPostId ? covers.get(item.rootPostId) : undefined}
                />
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

export function StorylineFeedCard({
  storyline,
  cover,
}: {
  storyline: StorylineCard;
  cover?: CoverImage;
}) {
  return (
    <Link
      href={storylineUrl(storyline.id)}
      className="flex h-full flex-col overflow-hidden rounded-lg border border-gray-3 dark:border-dark-4"
    >
      <div className="relative h-40 bg-gradient-to-br from-indigo-500 to-fuchsia-600">
        {cover && (
          <ImageGuard2 image={cover}>
            {(safe) =>
              safe ? (
                <EdgeMedia
                  src={cover.url}
                  type={cover.type}
                  width={450}
                  className="size-full object-cover"
                  loading="lazy"
                />
              ) : (
                <MediaHash {...cover} />
              )
            }
          </ImageGuard2>
        )}
        <Badge
          className="absolute left-2 top-2"
          color={storyline.status === 'Complete' ? 'gray' : 'green'}
          variant="filled"
          size="sm"
        >
          {storyline.status}
        </Badge>
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <Text fw={600} lineClamp={2}>
          {storyline.title}
        </Text>
        <Text size="xs" c="dimmed">
          by {storyline.user.username}
        </Text>
        <Text size="xs" c="dimmed">
          {storyline.chapterCount} {storyline.chapterCount === 1 ? 'chapter' : 'chapters'} ·{' '}
          {storyline.contributorCount} {storyline.contributorCount === 1 ? 'creator' : 'creators'}
        </Text>
      </div>
    </Link>
  );
}
