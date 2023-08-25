import React, { forwardRef } from 'react';
import { AutocompleteItem, Badge, BadgeProps, Center, Group, Stack, Text } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import { Highlight } from 'react-instantsearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import { Hit } from 'instantsearch.js';
import {
  ActionIconBadge,
  useSearchItemStyles,
  ViewMoreItem,
} from '~/components/AutocompleteSearch/renderItems/common';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { CollectionSearchIndexRecord } from '~/server/search-index/collections.search-index';

export const CollectionsSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: Hit<CollectionSearchIndexRecord> }
>(({ value, hit, ...props }, ref) => {
  const { theme, classes } = useSearchItemStyles();

  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { user, images, metrics } = hit;
  const [image] = images;

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
        {image.nsfw !== 'None' ? (
          <MediaHash {...image} cropFocus="top" />
        ) : (
          <EdgeMedia
            src={image.url}
            name={image.name ?? image.id.toString()}
            type={image.type}
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
      <Stack spacing={8} sx={{ flex: '1 !important' }}>
        <Text>
          <Highlight attribute="name" hit={hit} classNames={classes} />
        </Text>
        <UserAvatar size="xs" user={user} withUsername />

        {metrics && (
          <Group spacing={4}>
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
