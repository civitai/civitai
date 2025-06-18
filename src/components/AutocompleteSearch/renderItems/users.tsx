import React, { forwardRef } from 'react';
import type { ComboboxItem } from '@mantine/core';
import { Group, Image, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconDownload, IconUpload, IconUser, IconUsers } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ActionIconBadge, ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Username } from '~/components/User/Username';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

export const UserSearchItem = forwardRef<
  HTMLDivElement,
  ComboboxItem & { hit: SearchIndexDataMap['users'][number] }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { image, username, metrics } = hit;

  return (
    <Group ref={ref} {...props} key={hit.id} gap="md" align="flex-start" wrap="nowrap">
      {image ? (
        <Image
          src={getEdgeUrl(image, { width: 96 })}
          alt={username ?? ''}
          className="size-8 rounded-full"
        />
      ) : (
        <ThemeIcon variant="light" size={32} radius="xl">
          <IconUser size={18} stroke={2.5} />
        </ThemeIcon>
      )}
      <Stack gap={4}>
        <Text component="div" size="md" lineClamp={1}>
          <Username {...hit} inherit />
        </Text>
        {metrics && (
          <Group gap={4}>
            <ActionIconBadge icon={<IconUpload size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.uploadCount)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconUsers size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.followerCount)}
            </ActionIconBadge>
            <ActionIconBadge icon={<ThumbsUpIcon size={12} />}>
              {abbreviateNumber(metrics.thumbsUpCount ?? 0)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconDownload size={16} />}>
              {abbreviateNumber(metrics.downloadCount ?? 0)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

UserSearchItem.displayName = 'UserSearchItem';
