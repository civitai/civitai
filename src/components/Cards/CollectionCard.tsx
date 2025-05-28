import { ActionIcon, Badge, Group, Text } from '@mantine/core';
import { IconDotsVertical, IconLayoutGrid, IconUser } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { DEFAULT_EDGE_IMAGE_WIDTH, constants } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { SimpleUser } from '~/server/selectors/user.selector';
import type { MediaType } from '~/shared/utils/prisma/enums';
import type { CollectionGetInfinite } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';

type ImageProps = {
  id: number;
  nsfwLevel: NsfwLevel;
  postId?: number | null;
  width?: number | null;
  height?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
  url: string;
  type: MediaType;
  name?: string | null;
  meta?: ImageMetaProps | null;
};

export function CollectionCard({ data }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 7 / 9 });

  const getCoverImages = () => {
    if (data.image) return [data.image];

    if (data.images) {
      return data.images ?? [];
    }

    return [];
  };

  const getCoverSrcs = () => {
    if (data.image) return [];

    if (data.srcs) {
      return data.srcs ?? [];
    }

    return [];
  };

  const coverImages: ImageProps[] = getCoverImages();
  const coverSrcs: string[] = getCoverSrcs();
  const isMultiImage = coverImages.length !== 0 ? coverImages.length > 1 : coverSrcs.length > 1;
  const coverImagesCount = coverImages.length || coverSrcs.length;
  const contributorCount = data._count?.contributors || data.metrics?.contributorCount || 0;
  const itemCount = data._count?.items || data.metrics?.itemCount || 0;

  return (
    <FeedCard
      className={coverImages.length === 0 ? classes.noImage : undefined}
      href={`/collections/${data.id}`}
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
              : classes.imageGroupContainer
          }
        >
          {coverImages.length > 0 && (
            <ImageCover data={data} coverImages={coverImages.slice(0, 4)} />
          )}
          {coverSrcs.length > 0 && coverImages.length === 0 && (
            <ImageSrcCover data={data} coverSrcs={coverSrcs} />
          )}
        </div>

        <div className={cx('flex flex-col gap-2', classes.contentOverlay, classes.bottom)}>
          {data.user.id !== -1 && <UserAvatarSimple {...data.user} />}
          <Text className={classes.dropShadow} size="xl" weight={700} lineClamp={2} lh={1.2}>
            {data.name}
          </Text>
          <div className="flex flex-nowrap gap-1">
            <Badge className={cx(classes.statChip, classes.chip)} variant="light" radius="xl">
              <Group spacing={2}>
                <IconLayoutGrid size={14} stroke={2.5} />
                <Text size="xs">{abbreviateNumber(itemCount)}</Text>
              </Group>
              <Group spacing={2}>
                <IconUser size={14} stroke={2.5} />
                <Text size="xs">{abbreviateNumber(contributorCount)}</Text>
              </Group>
            </Badge>
          </div>
        </div>
      </div>
    </FeedCard>
  );
}

type HeaderData = Pick<Props['data'], 'id' | 'userId' | 'type' | 'mode'>;

function CollectionCardHeader({
  data,
  withinImageGuard = true,
}: {
  data: HeaderData;
  withinImageGuard?: boolean;
}) {
  const { classes, cx } = useCardStyles({ aspectRatio: 7 / 9 });

  return (
    <Group spacing={4} position="apart" className={cx(classes.contentOverlay, classes.top)} noWrap>
      <Group spacing="xs">
        {withinImageGuard && <ImageGuard2.BlurToggle className={classes.chip} radius="xl" />}
        <Badge className={cx(classes.infoChip, classes.chip)} variant="light" radius="xl">
          <Text color="white" size="xs" transform="capitalize">
            {data.type ? data.type + 's' : 'Mixed'}
          </Text>
        </Badge>
      </Group>
      <CollectionContextMenu
        collectionId={data.id}
        ownerId={data.userId}
        position="left-start"
        mode={data.mode}
      >
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

export function ImageCover({ data, coverImages }: { data: HeaderData; coverImages: ImageProps[] }) {
  const { classes } = useCardStyles({ aspectRatio: 7 / 9 });
  const isMultiImage = coverImages.length > 1;
  const coverImagesCount = coverImages.length;

  return (
    <>
      {coverImages.map((image, i) => (
        <ImageGuard2 key={image.id} image={image} connectType="collection" connectId={data.id}>
          {(safe) => (
            <>
              {/* TODO - update  ImageGuard2 to allow blurToggle to be given an image from outside of context */}
              {i === 0 && <CollectionCardHeader data={data} withinImageGuard />}
              {safe ? (
                <EdgeMedia
                  src={image.url}
                  type="image"
                  className={classes.image}
                  name={image.name ?? image.id.toString()}
                  alt={
                    image.meta
                      ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                      : image.name ?? undefined
                  }
                  placeholder="empty"
                  loading="lazy"
                  width={DEFAULT_EDGE_IMAGE_WIDTH}
                  anim={false}
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
              )}
            </>
          )}
        </ImageGuard2>
      ))}

      {coverImages.length === 0 && (
        <Text color="dimmed" sx={{ width: '100%', height: '100%' }}>
          This collection has no images
        </Text>
      )}
    </>
  );
}

export function ImageSrcCover({ data, coverSrcs }: { data: HeaderData; coverSrcs: string[] }) {
  const { classes } = useCardStyles({ aspectRatio: 7 / 9 });

  return (
    <>
      {coverSrcs.map((src) => (
        <EdgeMedia
          src={src}
          type="image"
          width={DEFAULT_EDGE_IMAGE_WIDTH}
          placeholder="empty"
          className={classes.image}
          loading="lazy"
          key={src}
          anim={false}
        />
      ))}
      <CollectionCardHeader data={data} withinImageGuard={false} />
    </>
  );
}

type Props = {
  data: Omit<CollectionGetInfinite[number], 'image'> & {
    metrics?: {
      itemCount: number;
      contributorCount: number;
    } | null;
    srcs?: string[] | null;
    images?: ImageProps[] | null;
  } & {
    image?: ImageProps | null;
  };
};
