import React, { forwardRef } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  AutocompleteItem,
  Badge,
  Center,
  Group,
  Rating,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  IconBrush,
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconPhotoOff,
} from '@tabler/icons-react';
import { Highlight } from 'react-instantsearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import { Hit } from 'instantsearch.js';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import {
  useSearchItemStyles,
  ViewMoreItem,
} from '~/components/AutocompleteSearch/renderItems/common';
import { StarRating } from '~/components/StartRating/StarRating';

export const ModelSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: Hit<ModelSearchIndexRecord & { image: any }> }
>(({ value, hit, ...props }, ref) => {
  const features = useFeatureFlags();
  const { classes, theme } = useSearchItemStyles();

  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { image: coverImage, user, nsfw, type, category, metrics, version } = hit;

  return (
    <Group ref={ref} {...props} key={hit.id} spacing="md" align="flex-start" noWrap>
      <Center
        sx={{
          width: 64,
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: theme.radius.sm,
        }}
      >
        {coverImage ? (
          nsfw || coverImage.nsfw !== 'None' ? (
            <MediaHash {...coverImage} cropFocus="top" />
          ) : (
            <EdgeMedia
              src={coverImage.url}
              name={coverImage.name ?? coverImage.id.toString()}
              type={coverImage.type}
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
      <Stack spacing={4} sx={{ flex: '1 !important' }}>
        <Group spacing={8}>
          <Text>
            <Highlight attribute="name" hit={hit} classNames={classes} />
          </Text>
          {features.imageGeneration && !!version?.generationCoverage?.covered && (
            <ThemeIcon color="white" variant="filled" radius="xl" size="sm">
              <IconBrush size={12} stroke={2.5} color={theme.colors.dark[6]} />
            </ThemeIcon>
          )}
        </Group>
        <Group spacing={8}>
          <UserAvatar size="xs" user={user} withUsername />
          {nsfw && (
            <Badge size="xs" color="red">
              NSFW
            </Badge>
          )}
          <Badge size="xs">{type}</Badge>
          {category && <Badge size="xs">{category.name}</Badge>}
        </Group>
        <Group spacing={4}>
          <IconBadge icon={<StarRating value={metrics.rating} size={12} />}>
            {abbreviateNumber(metrics.ratingCount)}
          </IconBadge>
          <IconBadge icon={<IconHeart size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.favoriteCount)}
          </IconBadge>
          <IconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.commentCount)}
          </IconBadge>
          <IconBadge icon={<IconDownload size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.downloadCount)}
          </IconBadge>
        </Group>
      </Stack>
    </Group>
  );
});

ModelSearchItem.displayName = 'ModelSearchItem';
