import { ActionIcon, Badge, Group, Stack, Text } from '@mantine/core';
import { IconDotsVertical, IconLayoutGrid, IconUser } from '@tabler/icons-react';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { CollectionGetInfinite } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import { NsfwLevel } from '@prisma/client';
import { SimpleUser } from '~/server/selectors/user.selector';

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

  const coverImages: ImageProps[] = getCoverImages();
  const isMultiImage = coverImages.length > 1;
  console.log(data.name, coverImages);

  return (
    <FeedCard
      className={coverImages.length === 0 ? classes.noImage : undefined}
      href={`/collections/${data.id}`}
      aspectRatio="square"
      sx={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
    >
      <div
        className={cx({
          [classes.root]: true,
          [classes.noHover]: isMultiImage,
        })}
      >
        {coverImages.length > 0 ? (
          <div className={isMultiImage ? classes.imageGroupContainer : undefined}>
            <ImageGuard
              nsfw
              images={coverImages}
              connect={{ entityId: data.id, entityType: 'collection' }}
              render={(image) => (
                <ImageGuard.Content>
                  {({ safe }) => {
                    if (!image) return <Text color="dimmed">This collection has no images</Text>;

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
                          isMultiImage ? { position: 'relative', width: '50%', height: '50%' } : {}
                        }
                      />
                    );
                  }}
                </ImageGuard.Content>
              )}
            >
              <Group
                spacing={4}
                position="apart"
                className={cx(classes.contentOverlay, classes.top)}
                noWrap
              >
                <Group>
                  <Badge color="dark" size="sm" variant="light" radius="xl">
                    {data.type ? data.type : 'Mixed'}
                  </Badge>
                  <ImageGuard.GroupToggleConnect sx={{ position: 'inherit' }} />
                </Group>
                <CollectionContextMenu
                  collectionId={data.id}
                  ownerId={data.userId}
                  position="left-start"
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
            </ImageGuard>
          </div>
        ) : (
          <>
            <Text color="dimmed">This collection has no images</Text>
            <Group
              spacing={4}
              position="apart"
              className={cx(classes.contentOverlay, classes.top)}
              noWrap
            >
              <Group>
                <ImageGuard.GroupToggleConnect sx={{ position: 'inherit' }} />
              </Group>
              <CollectionContextMenu
                collectionId={data.id}
                ownerId={data.userId}
                position="left-start"
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
          </>
        )}

        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.gradientOverlay)}
          spacing="sm"
        >
          <Group position="apart" noWrap>
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

type Props = { data: CollectionGetInfinite[number] };
