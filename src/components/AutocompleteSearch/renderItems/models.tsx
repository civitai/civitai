import {
  AutocompleteItem,
  Badge,
  Center,
  Group,
  Stack,
  Text,
  ThemeIcon,
  useMantineTheme,
} from '@mantine/core';
import { IconBrush, IconDownload, IconMessageCircle2, IconPhotoOff } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import { Highlight } from 'react-instantsearch';
import { ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import styles from './common.module.scss';

export const ModelSearchItem = forwardRef<
  HTMLDivElement,
  AutocompleteItem & { hit: SearchIndexDataMap['models'][number] }
>(({ value, hit, ...props }, ref) => {
  const features = useFeatureFlags();
  const theme = useMantineTheme();

  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { images, user, type, category, metrics, version, nsfw } = hit;
  const coverImage = images[0];
  const alt = coverImage.name;

  return (
    <Group ref={ref} {...props} key={hit.id} gap="md" align="flex-start" wrap="nowrap">
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
          !getIsSafeBrowsingLevel(coverImage.nsfwLevel) ? (
            <MediaHash {...coverImage} cropFocus="top" />
          ) : (
            <EdgeMedia
              src={coverImage.url}
              name={coverImage.name ?? coverImage.id.toString()}
              type={coverImage.type}
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
          <ThemeIcon variant="light" size={64} radius={0}>
            <IconPhotoOff size={32} />
          </ThemeIcon>
        )}
      </Center>
      <Stack gap={4} sx={{ flex: '1 !important' }}>
        <Group gap={8}>
          <Text>
            <Highlight attribute="name" hit={hit} classNames={styles} />
          </Text>
          {features.imageGeneration && !!version?.generationCoverage?.covered && (
            <ThemeIcon color="white" variant="filled" radius="xl" size="sm">
              <IconBrush size={12} stroke={2.5} color={theme.colors.dark[6]} />
            </ThemeIcon>
          )}
        </Group>
        <Group gap={8}>
          <UserAvatar size="xs" user={user} withUsername />
          {nsfw && (
            <Badge size="xs" color="red">
              NSFW
            </Badge>
          )}
          <Badge size="xs">{getDisplayName(type)}</Badge>
          {category && category.name && <Badge size="xs">{getDisplayName(category.name)}</Badge>}
        </Group>
        <Group gap={4}>
          <IconBadge icon={<ThumbsUpIcon size={12} />}>
            {abbreviateNumber(metrics.thumbsUpCount)}
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
