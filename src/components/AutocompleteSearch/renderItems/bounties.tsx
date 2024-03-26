import { AutocompleteItem, Center, Group, Skeleton, Stack, Text } from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import React, { forwardRef } from 'react';
import { Highlight } from 'react-instantsearch';
import {
  ActionIconBadge,
  ViewMoreItem,
  useSearchItemStyles,
} from '~/components/AutocompleteSearch/renderItems/common';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { abbreviateNumber } from '~/utils/number-helpers';

export const BountiesSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: SearchIndexDataMap['bounties'][number] }
>(({ value, hit, ...props }, ref) => {
  const { classes } = useSearchItemStyles();

  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { user, images, nsfwLevel, stats } = hit;
  const [image] = images;
  const alt = truncate((image.meta as ImageMetaProps)?.prompt, {
    length: constants.altTruncateLength,
  });

  const nsfw = !getIsSafeBrowsingLevel(image.nsfwLevel);

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
        {image ? (
          nsfw ? (
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
          )
        ) : (
          <Skeleton width="100px" height="100px" />
        )}
      </Center>
      <Stack spacing={8} sx={{ flex: '1 !important' }}>
        <Text>
          <Highlight attribute="name" hit={hit} classNames={classes} />
        </Text>
        <UserAvatar size="xs" user={user} withUsername />

        {stats && (
          <Group spacing={4}>
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={stats.unitAmountCountAllTime || 0}
            />
            <ActionIconBadge icon={<IconMoodSmile size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.favoriteCountAllTime || 0)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.commentCountAllTime || 0)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

BountiesSearchItem.displayName = 'BountiesSearchItem';
