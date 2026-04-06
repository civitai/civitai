import React, { forwardRef } from 'react';
import type { ComboboxItem } from '@mantine/core';
import { Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBook2, IconPhotoOff, IconUsers } from '@tabler/icons-react';
import { Highlight } from 'react-instantsearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ActionIconBadge } from '~/components/AutocompleteSearch/renderItems/common';
import styles from './common.module.scss';

export const ComicsSearchItem = forwardRef<
  HTMLDivElement,
  ComboboxItem & { hit: SearchIndexDataMap['comics'][number] }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { name, coverImageUrl, user, stats, genre } = hit;

  return (
    <Group ref={ref} {...props} key={hit.id} gap="md" align="flex-start" wrap="nowrap">
      <div
        style={{
          width: 64,
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '10px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {coverImageUrl ? (
          <EdgeMedia
            src={coverImageUrl}
            name={name}
            type="image"
            alt={name}
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
        ) : (
          <ThemeIcon variant="light" size={64} radius={0}>
            <IconPhotoOff size={32} />
          </ThemeIcon>
        )}
      </div>
      <Stack gap={4} style={{ flex: '1 !important' }}>
        <Highlight attribute="name" hit={hit} classNames={styles} />
        <Group gap={4}>
          <UserAvatar size="xs" user={user} withUsername />
          {genre && (
            <Text size="xs" c="dimmed">
              {genre}
            </Text>
          )}
        </Group>
        {stats && (
          <Group gap={4}>
            <ActionIconBadge icon={<IconBook2 size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.chapterCount)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconUsers size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.followerCount)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

ComicsSearchItem.displayName = 'ComicsSearchItem';
