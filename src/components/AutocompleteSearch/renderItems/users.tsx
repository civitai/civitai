import React, { forwardRef } from 'react';
import { AutocompleteItem, Group, Image, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconDownload, IconUpload, IconUser, IconUsers } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ActionIconBadge, ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Username } from '~/components/User/Username';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

export const UserSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: SearchIndexDataMap['users'][number] }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { image, username, stats, metrics } = hit;

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
        <Group spacing={4}>
          <ActionIconBadge icon={<IconUpload size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.uploadCount)}
          </ActionIconBadge>
          <ActionIconBadge icon={<IconUsers size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.followerCount)}
          </ActionIconBadge>
          <ActionIconBadge icon={<ThumbsUpIcon size={12} />}>
            {abbreviateNumber(stats?.thumbsUpCountAllTime ?? 0)}
          </ActionIconBadge>
          <ActionIconBadge icon={<IconDownload size={16} />}>
            {abbreviateNumber(stats?.downloadCountAllTime ?? 0)}
          </ActionIconBadge>
        </Group>
      </Stack>
    </Group>
  );
});

UserSearchItem.displayName = 'UserSearchItem';
