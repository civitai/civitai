import { Anchor, Badge, Button, Stack, Text, TextInput } from '@mantine/core';
import { IconCheck, IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { useId } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StorylineThumb, type StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import type { StorylinePostPaging } from '~/components/Storyline/storyline.data';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { isStorylineVerdictLevel } from '~/shared/utils/storyline-placement';
import { formatDate } from '~/utils/date-helpers';

export type StorylineContinuePost = {
  id: number;
  title: string | null;
  nsfwLevel: number;
  publishedAt?: Date | null;
  imageCount?: number;
  cover?: StorylineThumbImage | null;
};

/** Sizes the tile's image request. */
const TILE_WIDTH = 140;

/** The viewer's own posts as a grid of tiles to pick one from. */
export function StorylinePostPicker({
  posts,
  postsLoading,
  postsError,
  alreadyChapters = 0,
  allChaptersText,
  paging,
  postId,
  onPostChange,
  ceiling,
  isAboveCeiling,
}: {
  posts: StorylineContinuePost[];
  postsLoading?: boolean;
  postsError?: boolean;
  /** The viewer's posts left out because they are already chapters. */
  alreadyChapters?: number;
  /** Shown when every post was left out for being a chapter already. */
  allChaptersText: string;
  paging?: StorylinePostPaging;
  postId: number | null;
  onPostChange: (postId: number | null) => void;
  /** The storyline's ceiling, as a label. */
  ceiling: string;
  isAboveCeiling: (postLevel: number) => boolean;
}) {
  const pickerLabelId = useId();

  return (
    <Stack gap={6}>
      <Text size="sm" fw={500} id={pickerLabelId}>
        Your post
      </Text>
      {paging && (
        <TextInput
          size="sm"
          placeholder="Search your posts by title"
          aria-label="Search your posts by title"
          leftSection={<IconSearch size={16} />}
          value={paging.search}
          onChange={(event) => paging.onSearchChange(event.currentTarget.value)}
        />
      )}
      {postsLoading ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <StorylineThumb key={i} image={undefined} width={TILE_WIDTH} fluid />
          ))}
        </div>
      ) : postsError ? (
        <Text size="sm" c="red">
          Couldn&apos;t load your posts.
        </Text>
      ) : !posts.length && paging?.search.trim() && !alreadyChapters && !paging.hasMore ? (
        <Text size="sm" c="dimmed">
          None of your posts has a title starting with “{paging.search.trim()}”.
        </Text>
      ) : !posts.length ? (
        <Text size="sm" c="dimmed">
          {alreadyChapters ? allChaptersText : 'You have no published posts.'}{' '}
          <Anchor component={Link} href="/posts/create">
            Create a post
          </Anchor>
        </Text>
      ) : (
        <div
          role="radiogroup"
          aria-labelledby={pickerLabelId}
          className="-m-1 grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto p-1"
        >
          {posts.map((candidate) => (
            <StorylinePostTile
              key={candidate.id}
              post={candidate}
              ceiling={ceiling}
              aboveCeiling={isAboveCeiling(candidate.nsfwLevel)}
              selected={candidate.id === postId}
              onSelect={() => onPostChange(candidate.id)}
            />
          ))}
        </div>
      )}
      {alreadyChapters > 0 && posts.length > 0 && (
        <Text size="xs" c="dimmed">
          {alreadyChapters === 1
            ? '1 of your posts is already a chapter, so it isn’t listed.'
            : `${alreadyChapters} of your posts are already chapters, so they aren’t listed.`}
        </Text>
      )}
      {paging?.hasMore && !postsLoading && (
        <Button
          variant="default"
          size="xs"
          onClick={paging.loadMore}
          loading={paging.loadingMore}
          className="self-center"
        >
          Show older posts
        </Button>
      )}
    </Stack>
  );
}

function StorylinePostTile({
  post,
  ceiling,
  aboveCeiling,
  selected,
  onSelect,
}: {
  post: StorylineContinuePost;
  ceiling: string;
  aboveCeiling: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const name = post.title || (post.publishedAt ? formatDate(post.publishedAt) : `Post ${post.id}`);
  const unusable = isStorylineVerdictLevel(post.nsfwLevel);
  const rating = !post.nsfwLevel
    ? 'Not rated yet'
    : unusable
    ? "Can't be used"
    : getBrowsingLevelLabel(post.nsfwLevel);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={
        aboveCeiling
          ? `${name}, above this storyline's ${ceiling} limit`
          : `${name}, ${
              !post.nsfwLevel ? 'not rated yet' : unusable ? "can't be used" : `rated ${rating}`
            }`
      }
      onClick={onSelect}
      className={clsx(
        'flex min-w-0 flex-col gap-1 rounded-lg p-1 text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-blue-5/50',
        selected && 'ring-2 ring-blue-5 focus-visible:ring-blue-5'
      )}
    >
      <StorylineThumb image={post.cover ?? null} width={TILE_WIDTH} fluid dimmed={aboveCeiling}>
        {aboveCeiling && (
          <span className="absolute inset-x-1 bottom-1 rounded-full bg-black/55 px-2 py-0.5 text-center text-xs font-semibold text-white backdrop-blur-sm">
            Above {ceiling}
          </span>
        )}
        {selected && (
          <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-blue-6 text-white">
            <IconCheck size={14} stroke={3} />
          </span>
        )}
      </StorylineThumb>
      <Text size="xs" fw={500} lineClamp={1}>
        {name}
      </Text>
      <div className="flex items-center gap-1.5">
        <Badge variant="light" color="gray" size="xs" radius="xl">
          {rating}
        </Badge>
        {!!post.imageCount && (
          <Text size="xs" c="dimmed" lineClamp={1} data-testid="storyline-post-image-count">
            {post.imageCount} {post.imageCount === 1 ? 'image' : 'images'}
          </Text>
        )}
      </div>
    </button>
  );
}
