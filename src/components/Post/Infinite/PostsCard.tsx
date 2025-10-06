import { AspectRatio } from '@mantine/core';
import { memo } from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink } from '~/components/NextLink/NextLink';
import { PostReactions } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PostsInfiniteModel } from '~/server/services/post.service';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';
import classes from './PostsCard.module.css';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

export function PostsCard({
  data: { images, id, stats, imageCount, cosmetic, user },
  height,
}: {
  data: PostsInfiniteModel;
  height?: number;
}) {
  const currentUser = useCurrentUser();
  const image = images[0];
  const isOwner = currentUser?.id === user.id;
  return (
    <TwCosmeticWrapper cosmetic={cosmetic?.data} style={cosmetic?.data ? { height } : undefined}>
      <TwCard className="border shadow" style={!cosmetic?.data ? { height } : undefined}>
        <ImageGuard2 image={image} connectType="post" connectId={id}>
          {(safe) => (
            <>
              {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}

              <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
              {safe && (
                <ImageContextMenu
                  image={image}
                  context="post"
                  className="absolute right-2 top-2 z-10"
                  additionalMenuItems={
                    isOwner ? (
                      <AddArtFrameMenuItem
                        entityType={CosmeticEntity.Post}
                        entityId={id}
                        image={image}
                        currentCosmetic={cosmetic}
                      />
                    ) : null
                  }
                />
              )}

              <NextLink href={`/posts/${id}`}>
                {!safe ? (
                  <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                    <MediaHash {...image} />
                  </AspectRatio>
                ) : (
                  <EdgeMedia2
                    metadata={image.metadata}
                    src={image.url}
                    className={cardClasses.image}
                    name={image.name ?? image.id.toString()}
                    alt={image.name ?? undefined}
                    skip={getSkipValue(image)}
                    type={image.type}
                    width={450}
                    placeholder="empty"
                  />
                )}
              </NextLink>
              <PostReactions
                className={classes.reactions}
                imageCount={imageCount}
                metrics={{
                  likeCount: stats?.likeCount,
                  dislikeCount: stats?.dislikeCount,
                  heartCount: stats?.heartCount,
                  laughCount: stats?.laughCount,
                  cryCount: stats?.cryCount,
                }}
              />
            </>
          )}
        </ImageGuard2>
      </TwCard>
    </TwCosmeticWrapper>
  );
}

export const PostsCardMemoized = memo(PostsCard);
