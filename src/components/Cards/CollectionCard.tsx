import { ActionIcon, Badge, Group, Stack, Text } from '@mantine/core';
import { IconDotsVertical, IconLayoutGrid, IconUser } from '@tabler/icons-react';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { CollectionGetInfinite } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import { NsfwLevel } from '@prisma/client';
import { SimpleUser } from '~/server/selectors/user.selector';
import React from 'react';

type ImageProps = {
  id: number;
  nsfw: NsfwLevel;
  imageNsfw?: boolean;
  postId?: number | null;
  width?: number | null;
  height?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
  url: string;
  name?: string | null;
};

export function CollectionCard({ data }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });

  const getCoverImages = () => {
    if (data.image) return [data.image];

    return data.items
      .map((item) => {
        switch (item.type) {
          case 'model':
          case 'post':
            return item.data.image;
          case 'image':
            return item.data;
          case 'article':
          default:
            return null;
        }
      })
      .filter(isDefined)
      .slice(0, 4);
  };

  const getCoverSrcs = () => {
    if (data.image) return [];

    return data.items
      .map((item) => {
        switch (item.type) {
          case 'article':
            return item.data.cover;
          case 'model':
          case 'post':
          case 'image':
          default:
            return null;
        }
      })
      .filter(isDefined)
      .slice(0, 4);
  };

  const coverImages: ImageProps[] = getCoverImages();
  const coverSrcs: string[] = getCoverSrcs();
  const isMultiImage = coverImages.length !== 0 ? coverImages.length > 1 : coverSrcs.length > 1;
  const coverImagesCount = coverImages.length || coverSrcs.length;

  return (
    <FeedCard
      className={coverImages.length === 0 ? classes.noImage : undefined}
      href={`/collections/${data.id}`}
      aspectRatio="square"
      // Necessary when inside a UniformGrid
      sx={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
    >
      <div
        className={cx({
          [classes.root]: true,
          [classes.noHover]: isMultiImage,
        })}
      >
        <div
          className={
            isMultiImage
              ? cx({
                  [classes.imageGroupContainer]: true,
                  [classes.imageGroupContainer4x4]: coverImagesCount > 2,
                })
              : undefined
          }
        >
          {coverImages.length > 0 && <ImageCover data={data} coverImages={coverImages} />}
          {coverSrcs.length > 0 && coverImages.length === 0 && (
            <ImageSrcCover data={data} coverSrcs={coverSrcs} />
          )}
        </div>

        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.gradientOverlay)}
          spacing="sm"
        >
          <Group position="apart" align="flex-end" noWrap>
            <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
              {data.name}
            </Text>
            <Group spacing={4} noWrap>
              <IconBadge className={classes.iconBadge} icon={<IconLayoutGrid size={14} />}>
                <Text size="xs">{abbreviateNumber(data._count.items)}</Text>
              </IconBadge>
              <IconBadge className={classes.iconBadge} icon={<IconUser size={14} />}>
                <Text size="xs">{abbreviateNumber(data._count.contributors)}</Text>
              </IconBadge>
            </Group>
          </Group>
        </Stack>
      </div>
    </FeedCard>
  );
}

function CollectionCardHeader({
  data,
  withinImageGuard = true,
}: Props & { withinImageGuard?: boolean }) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });

  return (
    <Group spacing={4} position="apart" className={cx(classes.contentOverlay, classes.top)} noWrap>
      <Group spacing="xs">
        {withinImageGuard && (
          <ImageGuard.GroupToggleConnect
            className={classes.chip}
            sx={(theme) => ({ position: 'inherit', borderRadius: theme.radius.xl })}
          />
        )}
        <Badge className={cx(classes.infoChip, classes.chip)} variant="light" radius="xl">
          <Text color="white" size="xs" transform="capitalize">
            {data.type ? data.type + 's' : 'Mixed'}
          </Text>
        </Badge>
      </Group>
      <CollectionContextMenu collectionId={data.id} ownerId={data.userId} position="left-start">
        <ActionIcon
          variant="transparent"
          p={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical />
        </ActionIcon>
      </CollectionContextMenu>
    </Group>
  );
}

function ImageCover({ data, coverImages }: Props & { coverImages: ImageProps[] }) {
  const { classes } = useCardStyles({ aspectRatio: 1 });
  const isMultiImage = coverImages.length > 1;
  const coverImagesCount = coverImages.length;

  return (
    <ImageGuard
      nsfw
      images={coverImages}
      connect={{ entityId: data.id, entityType: 'collection' }}
      render={(image) => (
        <ImageGuard.Content>
          {({ safe }) => {
            return safe ? (
              <EdgeImage
                src={image.url}
                className={classes.image}
                name={image.name ?? image.id.toString()}
                alt={image.name ?? undefined}
                placeholder="empty"
                loading="lazy"
                width={DEFAULT_EDGE_IMAGE_WIDTH}
              />
            ) : (
              <MediaHash
                {...image}
                style={
                  isMultiImage
                    ? {
                        position: 'relative',
                        width: '50%',
                        height: coverImagesCount > 2 ? '50%' : 'auto',
                      }
                    : {}
                }
              />
            );
          }}
        </ImageGuard.Content>
      )}
    >
      <CollectionCardHeader data={data} withinImageGuard />

      {coverImages.length === 0 && (
        <Text color="dimmed" sx={{ width: '100%', height: '100%' }}>
          This collection has no images
        </Text>
      )}
    </ImageGuard>
  );
}

function ImageSrcCover({ data, coverSrcs }: Props & { coverSrcs: string[] }) {
  const { classes } = useCardStyles({ aspectRatio: 1 });

  return (
    <>
      {coverSrcs.map((src) => (
        <EdgeImage
          src={src}
          width={450}
          placeholder="empty"
          className={classes.image}
          loading="lazy"
          key={src}
        />
      ))}
      <CollectionCardHeader data={data} withinImageGuard={false} />
    </>
  );
}

type Props = { data: CollectionGetInfinite[number] };
