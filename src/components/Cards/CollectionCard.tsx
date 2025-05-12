import { ActionIcon, Badge, Group, Text } from '@mantine/core';
import { IconDotsVertical, IconLayoutGrid, IconUser } from '@tabler/icons-react';
import clsx from 'clsx';
import { truncate } from 'lodash-es';
import cardClasses from '~/components/Cards/Cards.module.scss';
import { FeedCard } from '~/components/Cards/FeedCard';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { DEFAULT_EDGE_IMAGE_WIDTH, constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { SimpleUser } from '~/server/selectors/user.selector';
import { MediaType } from '~/shared/utils/prisma/enums';
import { CollectionGetInfinite } from '~/types/router';
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
      style={{
        '--aspect-ratio': 7 / 9,
      }}
      className={coverImages.length === 0 ? cardClasses.noImage : undefined}
      href={`/collections/${data.id}`}
    >
      <div
        className={clsx({
          [cardClasses.root]: true,
          [cardClasses.noHover]: isMultiImage,
        })}
      >
        <div
          className={
            isMultiImage
              ? clsx({
                  [cardClasses.imageGroupContainer]: true,
                  [cardClasses.imageGroupContainer4x4]: coverImagesCount > 2,
                })
              : cardClasses.imageGroupContainer
          }
        >
          {coverImages.length > 0 && (
            <ImageCover data={data} coverImages={coverImages.slice(0, 4)} />
          )}
          {coverSrcs.length > 0 && coverImages.length === 0 && (
            <ImageSrcCover data={data} coverSrcs={coverSrcs} />
          )}
        </div>

        <div
          className={clsx('flex flex-col gap-2', cardClasses.contentOverlay, cardClasses.bottom)}
        >
          {data.user.id !== -1 && <UserAvatarSimple {...data.user} />}
          <Text className={cardClasses.dropShadow} size="xl" weight={700} lineClamp={2} lh={1.2}>
            {data.name}
          </Text>
          <div className="flex flex-nowrap gap-1">
            <Badge
              className={clsx(cardClasses.statChip, cardClasses.chip)}
              variant="light"
              radius="xl"
            >
              <Group gap={2}>
                <IconLayoutGrid size={14} stroke={2.5} />
                <Text size="xs">{abbreviateNumber(itemCount)}</Text>
              </Group>
              <Group gap={2}>
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
  return (
    <Group
      style={{
        '--aspect-ratio': 7 / 9,
      }}
      gap={4}
      justify="space-between"
      className={clsx(cardClasses.contentOverlay, cardClasses.top)}
      wrap="nowrap"
    >
      <Group gap="xs">
        {withinImageGuard && <ImageGuard2.BlurToggle className={cardClasses.chip} radius="xl" />}
        <Badge className={clsx(cardClasses.infoChip, cardClasses.chip)} variant="light" radius="xl">
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
  const isMultiImage = coverImages.length > 1;
  const coverImagesCount = coverImages.length;

  return (
    <div style={{ '--aspect-ratio': 7 / 9 }}>
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
                  className={cardClasses.image}
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
    </div>
  );
}

export function ImageSrcCover({ data, coverSrcs }: { data: HeaderData; coverSrcs: string[] }) {
  return (
    <div style={{ '--aspect-ratio': 7 / 9 }}>
      {coverSrcs.map((src) => (
        <EdgeMedia
          src={src}
          type="image"
          width={DEFAULT_EDGE_IMAGE_WIDTH}
          placeholder="empty"
          className={cardClasses.image}
          loading="lazy"
          key={src}
          anim={false}
        />
      ))}
      <CollectionCardHeader data={data} withinImageGuard={false} />
    </div>
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
