import { ActionIcon, Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { AudioMetadata } from '~/server/schema/media.schema';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { formatDuration } from '~/utils/number-helpers';

export function AudioCard({ data }: Props) {
  const context = useImagesContext();
  const router = useRouter();

  const metadata = data.metadata as AudioMetadata;

  return (
    <RoutedDialogLink name="imageDetail" state={{ imageId: data.id, ...context }}>
      <MasonryCard shadow="sm" bg="dark.6" style={{ borderRadius: 12 }} withBorder>
        <Stack spacing="lg" p="md">
          <Group spacing="sm" mr="-sm" noWrap>
            <EdgeMedia src={data.url} type="audio" duration={metadata.duration} />
            <Group spacing={4} noWrap>
              <Badge
                size="md"
                color="gray.8"
                variant="filled"
                radius="sm"
                px={4}
                py={2}
                style={{ flexShrink: 0, boxShadow: '1px 2px 3px -1px #25262B33' }}
              >
                <Text weight="bold" color="white" inherit>
                  {formatDuration(metadata.duration)}
                </Text>
              </Badge>
              <ImageContextMenu image={data} iconSize={20} context="audio" />
            </Group>
          </Group>
          <Stack spacing={4}>
            {data.user.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white', alignSelf: 'flex-start' }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  router.push(`/user/${data.user.username}`);
                }}
              >
                <UserAvatar
                  // Explicit casting to comply with ts
                  user={data.user as ImagesInfiniteModel['user']}
                  avatarProps={{ radius: 'xl', size: 24 }}
                  withUsername
                />
              </UnstyledButton>
            )}
            <Text size="xl" weight={600} lineClamp={3} lh={1.2}>
              {data.name}
            </Text>
          </Stack>

          <Group spacing={4} position="apart">
            <Reactions
              entityId={data.id}
              entityType="image"
              reactions={data.reactions}
              metrics={{
                likeCount: data.stats?.likeCountAllTime,
                dislikeCount: data.stats?.dislikeCountAllTime,
                heartCount: data.stats?.heartCountAllTime,
                laughCount: data.stats?.laughCountAllTime,
                cryCount: data.stats?.cryCountAllTime,
                tippedAmountCount: data.stats?.tippedAmountCountAllTime,
              }}
              targetUserId={data.user.id}
            />
            {data.meta && (
              <ImageMetaPopover meta={data.meta}>
                <ActionIcon variant="transparent">
                  <IconInfoCircle strokeWidth={2.5} size={18} />
                </ActionIcon>
              </ImageMetaPopover>
            )}
          </Group>
        </Stack>
      </MasonryCard>
    </RoutedDialogLink>
  );
}

type Props = { data: ImagesInfiniteModel };
