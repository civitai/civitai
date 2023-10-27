import React, { forwardRef } from 'react';
import { AutocompleteItem, Group, Image, Rating, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconDownload, IconHeart, IconUpload, IconUser, IconUsers } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { Hit } from 'instantsearch.js';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { ActionIconBadge, ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Username } from '~/components/User/Username';
import { StarRating } from '~/components/StartRating/StarRating';

export const UserSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: Hit<UserSearchIndexRecord> }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { image, username, stats } = hit;

  return (
    <Group ref={ref} {...props} key={hit.id} spacing="md" align="flex-start" noWrap>
      {image ? (
        <Image
          src={getEdgeUrl(image, { width: 96 })}
          alt={username ?? ''}
          width={32}
          height={32}
          radius="xl"
        />
      ) : (
        <ThemeIcon variant="light" size={32} radius="xl">
          <IconUser size={18} stroke={2.5} />
        </ThemeIcon>
      )}
      <Stack spacing={4}>
        <Text size="md" lineClamp={1}>
          <Username {...hit} inherit />
        </Text>
        {stats && (
          <Group spacing={4}>
            <ActionIconBadge icon={<StarRating value={stats.ratingAllTime} size={12} />}>
              {abbreviateNumber(stats.ratingCountAllTime)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconUpload size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.uploadCountAllTime)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconUsers size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.followerCountAllTime)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconHeart size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.favoriteCountAllTime)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconDownload size={16} />}>
              {abbreviateNumber(stats.downloadCountAllTime)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

UserSearchItem.displayName = 'UserSearchItem';
