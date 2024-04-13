import React, { forwardRef } from 'react';
import { AutocompleteItem, Badge, BadgeProps, Center, Group, Stack, Text } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import {
  ActionIconBadge,
  useSearchItemStyles,
  ViewMoreItem,
} from '~/components/AutocompleteSearch/renderItems/common';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { truncate } from 'lodash-es';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { constants } from '~/server/common/constants';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

export const ImagesSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: SearchIndexDataMap['images'][number] }
>(({ value, hit, ...props }, ref) => {
  const { theme } = useSearchItemStyles();

  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { user, tagNames, stats } = hit;
  const alt = truncate((hit.meta as ImageMetaProps)?.prompt, {
    length: constants.altTruncateLength,
  });
  const { commentCountAllTime, reactionCountAllTime } = stats || {
    commentCountAllTime: 0,
    reactionCountAllTime: 0,
  };
  const tagsMax = tagNames?.slice(0, 3);
  const remainingTagsCount = tagNames?.slice(3).length;

  const tagBadgeProps: BadgeProps = {
    radius: 'xl',
    size: 'xs',
    color: 'gray',
    variant: theme.colorScheme === 'dark' ? 'filled' : 'light',
  };

  const nsfw = !getIsSafeBrowsingLevel(hit.nsfwLevel);

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
        {nsfw ? (
          <MediaHash {...hit} cropFocus="top" />
        ) : (
          <EdgeMedia
            src={hit.url}
            name={hit.name ?? hit.id.toString()}
            type={hit.type}
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
      <Stack spacing={8} sx={{ flex: '1 !important' }}>
        {hit.meta && (
          <Text lineClamp={2} size="sm" inline>
            <Text weight={600} ml={1} span>
              Positive prompt:{' '}
            </Text>

            {hit.meta?.prompt ?? ''}
          </Text>
        )}
        <UserAvatar size="xs" user={user} withUsername />
        <Group spacing={8}>
          {tagsMax?.map((tag, index) => (
            <Badge key={index} {...tagBadgeProps}>
              {tag}
            </Badge>
          ))}
          {remainingTagsCount > 0 && <Badge {...tagBadgeProps}>+{remainingTagsCount}</Badge>}
        </Group>
        {stats && (
          <Group spacing={4}>
            <ActionIconBadge icon={<IconMoodSmile size={12} stroke={2.5} />}>
              {abbreviateNumber(reactionCountAllTime)}
            </ActionIconBadge>
            <ActionIconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
              {abbreviateNumber(commentCountAllTime)}
            </ActionIconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
});

ImagesSearchItem.displayName = 'ImagesSearchItem';
