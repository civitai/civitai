import { ActionIcon, Group, Stack, UnstyledButton } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { ImageGetInfinite } from '~/types/router';

export function ImageCard({ data, collectionId }: Props) {
  const { classes: sharedClasses, cx } = useCardStyles({
    aspectRatio: data.width && data.height ? data.width / data.height : 1,
  });
  const router = useRouter();

  return (
    <RoutedContextLink
      modal="imageDetailModal"
      imageId={data.id}
      collectionId={collectionId}
      period="AllTime"
    >
      <FeedCard>
        <div className={sharedClasses.root}>
          <ImageGuard
            images={[data]}
            render={(image) => (
              <ImageGuard.Content>
                {({ safe }) => {
                  // Small hack to prevent blurry landscape images
                  const originalAspectRatio =
                    image.width && image.height ? image.width / image.height : 1;

                  return (
                    <>
                      <ImageGuard.Report context="image" position="top-right" />
                      <ImageGuard.ToggleImage position="top-left" />
                      {safe ? (
                        <EdgeImage
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          width={
                            originalAspectRatio > 1
                              ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
                              : DEFAULT_EDGE_IMAGE_WIDTH
                          }
                          placeholder="empty"
                          className={sharedClasses.image}
                          loading="lazy"
                        />
                      ) : (
                        <MediaHash {...image} />
                      )}
                    </>
                  );
                }}
              </ImageGuard.Content>
            )}
          />
          <Stack
            className={cx(
              sharedClasses.contentOverlay,
              sharedClasses.bottom,
              sharedClasses.gradientOverlay
            )}
            spacing="sm"
          >
            {data.user.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white' }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  router.push(`/users/${data.user.username}`);
                }}
              >
                <UserAvatar
                  user={data.user}
                  avatarProps={{ radius: 'md', size: 32 }}
                  withUsername
                />
              </UnstyledButton>
            )}
            <Group spacing={4} position="apart">
              <Reactions
                className={sharedClasses.infoChip}
                entityId={data.id}
                entityType="image"
                reactions={data.reactions}
                metrics={{
                  likeCount: data.stats?.likeCountAllTime,
                  dislikeCount: data.stats?.dislikeCountAllTime,
                  heartCount: data.stats?.heartCountAllTime,
                  laughCount: data.stats?.laughCountAllTime,
                  cryCount: data.stats?.cryCountAllTime,
                }}
              />
              {!data.hideMeta && data.meta && (
                <ImageMetaPopover
                  meta={data.meta}
                  generationProcess={data.generationProcess ?? undefined}
                  imageId={data.id}
                >
                  <ActionIcon className={sharedClasses.infoChip} variant="light">
                    <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
                  </ActionIcon>
                </ImageMetaPopover>
              )}
            </Group>
          </Stack>
        </div>
      </FeedCard>
    </RoutedContextLink>
  );
}

type Props = { data: ImageGetInfinite[number]; collectionId?: number };
