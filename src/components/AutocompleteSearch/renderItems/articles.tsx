import React, { forwardRef } from 'react';
import type { ComboboxItem } from '@mantine/core';
import { Badge, Center, Group, Stack, ThemeIcon } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  IconBookmark,
  IconEye,
  IconMessageCircle2,
  IconMoodSmile,
  IconPhotoOff,
} from '@tabler/icons-react';
import { Highlight } from 'react-instantsearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ActionIconBadge, ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import styles from './common.module.scss';

export const ArticlesSearchItem = forwardRef<
  HTMLDivElement,
  ComboboxItem & { hit: SearchIndexDataMap['articles'][number] }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { coverImage, user, tags, stats, title } = hit;
  const { commentCount, viewCount, favoriteCount, ...reactionStats } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    likeCount: 0,
  };
  const reactionCount = Object.values(reactionStats).reduce((a, b) => a + b, 0);
  const nsfw = !getIsSafeBrowsingLevel(coverImage.nsfwLevel);

  return (
    <Group ref={ref} {...props} key={hit.id} gap="md" align="flex-start" wrap="nowrap">
      <Center
        style={{
          width: 64,
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '10px',
        }}
      >
        {coverImage ? (
          nsfw ? (
            <MediaHash {...coverImage} cropFocus="top" />
          ) : (
            <EdgeMedia
              src={coverImage.url}
              name={coverImage.name ?? coverImage.id.toString()}
              type={coverImage.type}
              alt={title}
              anim={false}
              width={450}
              style={{
                minWidth: '100%',
                minHeight: '100%',
                objectFit: 'cover',
                position: 'absolute',
                top: 0,
                left: 0,
              }}
            />
          )
        ) : (
          <ThemeIcon variant="light" size={64} radius={0}>
            <IconPhotoOff size={32} />
          </ThemeIcon>
        )}
      </Center>
      <Stack gap={4} style={{ flex: '1 !important' }}>
        <Highlight attribute="title" hit={hit} classNames={styles} />
        <Group gap={4}>
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
          <Group gap={4}>
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
