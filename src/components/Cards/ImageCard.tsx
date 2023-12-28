import { ActionIcon, Group, Stack, UnstyledButton } from '@mantine/core';
import { IconBrush, IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { ImageGetInfinite } from '~/types/router';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import HoverActionButton from './components/HoverActionButton';
import { generationPanel } from '~/store/generation.store';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { CosmeticType } from '@prisma/client';
import { HolidayFrame } from '../Decorations/HolidayFrame';

export function UnroutedImageCard({ data }: Props) {
  const { classes: sharedClasses, cx } = useCardStyles({
    aspectRatio: data.width && data.height ? data.width / data.height : 1,
  });
  const router = useRouter();
  const features = useFeatureFlags();

  const cardDecoration = data.user.cosmetics?.find(
    ({ cosmetic }) => cosmetic.type === CosmeticType.ContentDecoration
  ) as (typeof data.user.cosmetics)[number] & {
    data?: { lights?: number; upgradedLights?: number };
  };

  return (
    <HolidayFrame {...cardDecoration}>
      <FeedCard className={sharedClasses.link}>
        <div className={sharedClasses.root}>
          <ImageGuard
            images={[data]}
            render={(image) => (
              <ImageGuard.Content>
                {({ safe }) => {
                  // Small hack to prevent blurry landscape images
                  const originalAspectRatio =
                    image.width && image.height ? image.width / image.height : 1;
                  const onSite = image.meta && 'civitaiResources' in image.meta;

                  return (
                    <>
                      {onSite && <OnsiteIndicator />}
                      <Group
                        position="apart"
                        align="start"
                        spacing={4}
                        className={cx(sharedClasses.contentOverlay, sharedClasses.top)}
                      >
                        <ImageGuard.ToggleImage className={sharedClasses.chip} position="static" />
                        <Stack spacing="xs" ml="auto">
                          <ImageGuard.Report context="image" position="static" withinPortal />
                          {features.imageGeneration && image.meta && (
                            <HoverActionButton
                              label="Create"
                              size={30}
                              color="white"
                              variant="filled"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                generationPanel.open({
                                  type: 'image',
                                  id: image.id,
                                });
                              }}
                            >
                              <IconBrush stroke={2.5} size={16} />
                            </HoverActionButton>
                          )}
                        </Stack>
                      </Group>
                      {safe ? (
                        <EdgeMedia
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          type={image.type}
                          width={
                            originalAspectRatio > 1
                              ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
                              : DEFAULT_EDGE_IMAGE_WIDTH
                          }
                          className={sharedClasses.image}
                          wrapperProps={{ style: { height: '100%', width: '100%' } }}
                          loading="lazy"
                          contain
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
              'footer',
              sharedClasses.contentOverlay,
              sharedClasses.bottom,
              sharedClasses.gradientOverlay
            )}
            spacing="sm"
          >
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
                  user={data.user as ImageGetInfinite[number]['user']}
                  avatarProps={{ radius: 'md', size: 32 }}
                  withUsername
                />
              </UnstyledButton>
            )}
            <Group spacing={4} position="apart">
              <Reactions
                className={sharedClasses.reactions}
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
    </HolidayFrame>
  );
}
export function ImageCard({ data }: Props) {
  const context = useImagesContext();

  return (
    <RoutedDialogLink name="imageDetail" state={{ imageId: data.id, ...context }}>
      <UnroutedImageCard data={data} />
    </RoutedDialogLink>
  );
}

type Props = { data: ImageGetInfinite[number] | ImageSearchIndexRecord };
