import { ActionIcon, Badge, Button, Center, Group, Loader, Paper, Stack } from '@mantine/core';
import { IconBrush, IconInfoCircle } from '@tabler/icons-react';
import { Fragment, useMemo, useRef, useState } from 'react';
import { AdUnitTop } from '~/components/Ads/AdUnit';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { shouldDisplayHtmlControls } from '~/components/EdgeMedia/EdgeMedia.util';
import type { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { PostContestCollectionInfoAlert } from '~/components/Post/Detail/PostContestCollectionInfoAlert';
import { PostStickerOverlay } from '~/components/Post/Detail/PostStickerOverlay';
import { StickerPlacementBatchProvider } from '~/components/Sticker/StickerPlacementBatchProvider';
import { StickerPlacementCardBadge } from '~/components/Sticker/StickerPlacementCardBadge';
import { Reactions } from '~/components/Reaction/Reactions';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';
import type { VideoMetadata } from '~/server/schema/media.schema';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { CollectionItemStatus, MediaType } from '~/shared/utils/prisma/enums';
import { RemixMenu, isRemixMenuVisible } from '~/components/Image/Remix/RemixMenu';
import type { PostContestCollectionItem } from '~/types/router';
import classes from './PostImages.module.css';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';

const maxWidth = MAX_POST_IMAGES_WIDTH;
const maxInitialImages = 20;
export function PostImages({
  postId,
  images,
  isLoading,
  collectionItems,
  isOwner,
  isModerator,
}: {
  postId: number;
  images: ImagesInfiniteModel[];
  isLoading?: boolean;
  collectionItems?: PostContestCollectionItem[];
  isOwner?: boolean;
  isModerator?: boolean;
}) {
  const [showMore, setShowMore] = useState(false);
  const videoRef = useRef<EdgeVideoRef | null>(null);
  const features = useFeatureFlags();

  // Every image in the post, not the `_images` slice below: the batch provider
  // keys its chunks on the joined id string, so handing it a slice that grows on
  // "Load more" refetches the first twenty alongside the rest. A post is well
  // inside the provider's 100-id chunk, so this is one query either way.
  const imageIds = useMemo(() => images.map((image) => image.id), [images]);

  if (isLoading)
    return (
      <Paper component={Center} p="xl" mih={300} withBorder>
        <Group>
          <Loader />
          Loading Images
        </Group>
      </Paper>
    );

  const remainingImages = images.length - maxInitialImages;
  const _images = showMore ? images : images.slice(0, maxInitialImages);

  return (
    <StickerPlacementBatchProvider imageIds={imageIds}>
      <ContainerProvider containerName="post-detail" className="gap-4">
        {_images.map((image, i) => {
          const width = image.width ?? maxWidth;
          const imageCollectionItem = collectionItems?.find((item) => item.imageId === image.id);
          const showImageCollectionBadge =
            imageCollectionItem?.tag &&
            (isOwner ||
              isModerator ||
              imageCollectionItem.status === CollectionItemStatus.ACCEPTED);
          const vimeoVideoId = (image.metadata as VideoMetadata)?.vimeoVideoId;
          // One predicate for both the prop that asks for a control strip and the
          // class that moves the reaction bar clear of one. Spelling it twice is
          // how the reaction bar came to sit top-left over still images:
          // `nativeVideoControls` is a site-wide user preference, and EdgeMedia
          // only forwards `html5Controls` to EdgeVideo.
          const showsControlStrip =
            image.type === MediaType.video &&
            (features.nativeVideoControls || shouldDisplayHtmlControls(image));

          return (
            <Fragment key={image.id}>
              <PostContestCollectionInfoAlert
                isOwner={isOwner}
                collectionItem={imageCollectionItem}
                itemLabel="image"
                isModerator={isModerator}
              />
              <Paper
                key={image.id}
                radius="md"
                className="relative overflow-hidden"
                shadow="md"
                mx="auto"
                style={{
                  maxWidth: '100%',
                  width: width < maxWidth ? width : maxWidth,
                  aspectRatio:
                    image.width && image.height ? `${image.width}/${image.height}` : undefined,
                }}
              >
                <ImageGuard2 image={image} connectType="post" connectId={postId}>
                  {(safe) => (
                    <>
                      <Group gap={4} className="absolute left-2 top-2 z-10">
                        <ImageGuard2.BlurToggle />
                        {/* Beside the blur toggle rather than the reactions, where
                          a feed card puts it: this bar moves to three different
                          corners depending on video controls. */}
                        {features.stickerPlacement && (
                          <StickerPlacementCardBadge imageId={image.id} />
                        )}
                        {showImageCollectionBadge && (
                          <Badge variant="filled" color="gray">
                            {imageCollectionItem?.tag?.name}
                          </Badge>
                        )}
                      </Group>
                      <div
                        className={clsx('absolute right-2 top-2 z-10 flex flex-col gap-2', {
                          'right-10 top-2.5': !!vimeoVideoId,
                        })}
                      >
                        <ImageContextMenu image={image} />
                        {features.imageGeneration && isRemixMenuVisible(image) && (
                          <RemixMenu image={image} source="remix:post-image-card">
                            <HoverActionButton
                              label="Remix"
                              size={30}
                              color="white"
                              variant="filled"
                              data-activity="remix:post-image-card"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                            >
                              <IconBrush stroke={2.5} size={16} />
                            </HoverActionButton>
                          </RemixMenu>
                        )}
                      </div>
                      <RoutedDialogLink
                        name="imageDetail"
                        state={{
                          imageId: image.id,
                          images,
                          collectionId: imageCollectionItem?.collection?.id,
                        }}
                        onClick={() => {
                          if (videoRef.current) videoRef.current.stop();
                        }}
                      >
                        {!safe ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              aspectRatio: (image.width ?? 1) / (image.height ?? 1),
                            }}
                          >
                            <MediaHash {...image} />
                          </div>
                        ) : (
                          <EdgeMedia
                            src={image.url}
                            name={image.name}
                            alt={image.name ?? undefined}
                            type={image.type}
                            imageId={image.id}
                            width={width < maxWidth ? width : maxWidth}
                            original={image.type === 'video'}
                            anim={safe}
                            html5Controls={showsControlStrip}
                            videoRef={videoRef}
                            vimeoVideoId={vimeoVideoId}
                          />
                        )}
                      </RoutedDialogLink>
                      {safe && features.stickerPlacement && (
                        <PostStickerOverlay imageId={image.id} />
                      )}
                      <Reactions
                        className={clsx(classes.reactions, {
                          [classes.reactionsWithControls]: !vimeoVideoId && showsControlStrip,
                          [classes.vimeoReactions]: !!vimeoVideoId,
                        })}
                        entityId={image.id}
                        entityType="image"
                        reactions={image.reactions}
                        metrics={{
                          likeCount: image.stats?.likeCountAllTime,
                          dislikeCount: image.stats?.dislikeCountAllTime,
                          heartCount: image.stats?.heartCountAllTime,
                          laughCount: image.stats?.laughCountAllTime,
                          cryCount: image.stats?.cryCountAllTime,
                        }}
                        targetUserId={image.user.id}
                        readonly={!safe}
                        disableBuzzTip={image.poi}
                      />
                      {image.hasMeta && (
                        <div className="absolute bottom-2 right-2">
                          <ImageMetaPopover2 imageId={image.id} type={image.type}>
                            <LegacyActionIcon variant="transparent" size="lg" component="span">
                              <IconInfoCircle
                                color="white"
                                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                opacity={0.8}
                                strokeWidth={2.5}
                                size={26}
                              />
                            </LegacyActionIcon>
                          </ImageMetaPopover2>
                        </div>
                      )}
                    </>
                  )}
                </ImageGuard2>
              </Paper>
              {i > 0 && (i - 1) % 3 === 0 && <AdUnitTop maxWidth={760} preserveLayout={false} />}
            </Fragment>
          );
        })}
        {remainingImages > 0 && (
          <Button onClick={() => setShowMore(true)}>Load {remainingImages} more images</Button>
        )}
      </ContainerProvider>
    </StickerPlacementBatchProvider>
  );
}
