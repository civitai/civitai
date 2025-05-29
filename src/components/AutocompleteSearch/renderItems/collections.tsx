import React, { forwardRef } from 'react';
import type { ComboboxItem } from '@mantine/core';
import { Center, Group, Stack, Text } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import { Highlight } from 'react-instantsearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ActionIconBadge, ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { truncate } from 'lodash-es';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { constants } from '~/server/common/constants';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import styles from './common.module.scss';

export const CollectionsSearchItem = forwardRef<
  HTMLDivElement,
  ComboboxItem & { hit: SearchIndexDataMap['collections'][number] }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { user, images, metrics } = hit;
  const [image] = images;
  const alt = truncate((image.meta as ImageMetaProps)?.prompt, {
    length: constants.altTruncateLength,
  });

  const nsfw = !getIsSafeBrowsingLevel(image.nsfwLevel);

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
        {nsfw ? (
          <MediaHash {...image} cropFocus="top" />
        ) : (
          <EdgeMedia
            src={image.url}
            name={image.name ?? image.id.toString()}
            type={image.type}
            alt={alt}
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
        )}
      </Center>
      <Stack gap={8} style={{ flex: '1 !important' }}>
        <Text>
          <Highlight attribute="name" hit={hit} classNames={styles} />
        </Text>
        <UserAvatar size="xs" user={user} withUsername />

        {metrics && (
          <Group gap={4}>
            <ActionIconBadge icon={<IconMoodSmile size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.followerCount || 0)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.itemCount || 0)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

CollectionsSearchItem.displayName = 'CollectionsSearchItem';
