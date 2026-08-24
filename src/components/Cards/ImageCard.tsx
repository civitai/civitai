import { IconInfoCircle } from '@tabler/icons-react';
import { Reactions } from '~/components/Reaction/Reactions';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CardRemixButton } from '~/components/Image/Remix/CardRemixButton';
import { RemixedCardBadge, RemixedCardPeel } from '~/components/RemixGallery/RemixedCardBadge';
import { CardStickerOverlay } from '~/components/Sticker/CardStickerOverlay';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { StickerPlacementCardBadge } from '~/components/Sticker/StickerPlacementCardBadge';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import cardClasses from '~/components/Cards/Cards.module.css';
import { ThemeIcon } from '@mantine/core';

export function ImageCard({ data }: Props) {
  const { getImages, ...context } = useImagesContext();
  const features = useFeatureFlags();

  return (
    <AspectRatioImageCard
      image={data}
      cosmetic={data.cosmetic?.data}
      routedDialog={{
        name: 'imageDetail',
        state: { imageId: data.id, images: getImages(), ...context },
      }}
      overlay={({ safe }) =>
        // Not mounted at all with the flag off. The overlay renders null there
        // anyway, but a card is rendered by the hundred and this keeps the
        // flag-off tree identical to what shipped before it.
        safe && (
          <>
            {features.stickerPlacement && <CardStickerOverlay imageId={data.id} />}
            <RemixedCardPeel imageId={data.id} />
          </>
        )
      }
      header={
        <div className="flex w-full items-start justify-between">
          {data.type === 'video' && data.metadata && 'duration' in data.metadata && (
            <DurationBadge duration={data.metadata.duration ?? 0} className={cardClasses.chip} />
          )}
          <div className="ml-auto flex flex-col gap-2">
            <ImageContextMenu image={data} />
            <CardRemixButton image={data} />
            <RemixedCardBadge imageId={data.id} />
          </div>
        </div>
      }
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple {...data.user} />
          <div className="flex flex-wrap justify-between gap-1">
            <Reactions
              className={cardClasses.reactions}
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
              disableBuzzTip={data.poi}
            />
            {features.stickerPlacement && <StickerPlacementCardBadge imageId={data.id} />}
            {features.imageCardInfoButton && data.hasMeta && (
              <ImageMetaPopover2 imageId={data.id} type={data.type}>
                <ThemeIcon className={cardClasses.infoChip} variant="light">
                  <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
                </ThemeIcon>
              </ImageMetaPopover2>
            )}
          </div>
        </div>
      }
    />
  );
}

type Props = { data: ImagesInfiniteModel };
