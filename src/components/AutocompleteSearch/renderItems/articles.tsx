import React, { forwardRef } from 'react';
import { AutocompleteItem, Badge, Center, Group, Stack } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBookmark, IconEye, IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import { Highlight } from 'react-instantsearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import {
  ActionIconBadge,
  useSearchItemStyles,
  ViewMoreItem,
} from '~/components/AutocompleteSearch/renderItems/common';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';

export const ArticlesSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: SearchIndexDataMap['articles'][number] }
>(({ value, hit, ...props }, ref) => {
  const { classes } = useSearchItemStyles();

  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { coverImage, user, nsfw, tags, stats } = hit;
  const { commentCount, viewCount, favoriteCount, ...reactionStats } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    likeCount: 0,
  };
  const reactionCount = Object.values(reactionStats).reduce((a, b) => a + b, 0);

  return (
    <Group ref={ref} {...props} key={hit.id} spacing="md" align="flex-start" noWrap>
      <Center
        sx={{
          width: 64,
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '10px',
        }}
      >
        {/* TODO.Briant - ImageGuard */}
        {coverImage && (
          <EdgeMedia
            src={coverImage.url}
            width={450}
            style={{ minWidth: '100%', minHeight: '100%', objectFit: 'cover' }}
          />
        )}
      </Center>
      <Stack spacing={4} sx={{ flex: '1 !important' }}>
        <Highlight attribute="title" hit={hit} classNames={classes} />
        <Group spacing={4}>
          <UserAvatar size="xs" user={user} withUsername />
          {nsfw && (
            <Badge size="xs" color="red">
              NSFW
            </Badge>
          )}
          {tags?.map((tag) => (
            <Badge key={tag.id} size="xs">
              {tag.name}
            </Badge>
          ))}
        </Group>
        {stats && (
          <Group spacing={4}>
            <ActionIconBadge icon={<IconBookmark size={12} stroke={2.5} />}>
              {abbreviateNumber(favoriteCount)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconMoodSmile size={12} stroke={2.5} />}>
              {abbreviateNumber(reactionCount)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
              {abbreviateNumber(commentCount)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconEye size={12} stroke={2.5} />}>
              {abbreviateNumber(viewCount)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

ArticlesSearchItem.displayName = 'ArticlesSearchItem';
