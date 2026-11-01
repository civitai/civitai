import { IconInfoCircle } from '@tabler/icons-react';
import { ImageBuzzTip, Reactions } from '~/components/Reaction/Reactions';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CardRemixButton } from '~/components/Image/Remix/CardRemixButton';
import { REMIX_FRAME } from '~/components/RemixGallery/remix-card-state';
import { useRemixCardData } from '~/components/RemixGallery/use-remix-card-data';
import { RemixedCardFlyout } from '~/components/RemixGallery/RemixedCardFlyout';
import { CardStickerOverlay } from '~/components/Sticker/CardStickerOverlay';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { StickerPlacementCardBadge } from '~/components/Sticker/StickerPlacementCardBadge';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import cardClasses from '~/components/Cards/Cards.module.css';
import { ThemeIcon } from '@mantine/core';
import clsx from 'clsx';

export function ImageCard({ data }: Props) {
  const { getImages, ...context } = useImagesContext();
  const features = useFeatureFlags();
  // Called unconditionally: inside the `??` below it would sit after a
  // short-circuit, which is a conditional hook call.
  const remix = useRemixCardData(data.id);

  return (
    <AspectRatioImageCard
      image={data}
      // The owner's own cosmetic wins; the remix frame is only a fallback.
      cosmetic={data.cosmetic?.data ?? (remix.count ? REMIX_FRAME : undefined)}
      eventDecoration={data.eventDecoration?.data}
      eventDecorationOn={{ entityType: 'Image', entityId: data.id }}
      routedDialog={{
        name: 'imageDetail',
        state: { imageId: data.id, images: getImages(), ...context },
      }}
      overlay={({ safe }) =>
        // Not mounted at all with the flag off. The overlay renders null there
        // anyway, but a card is rendered by the hundred and this keeps the
        // flag-off tree identical to what shipped before it.
        safe && features.stickerPlacement && <CardStickerOverlay imageId={data.id} />
      }
      header={
        <div className="flex w-full items-start justify-between">
          {data.type === 'video' && data.metadata && 'duration' in data.metadata && (
            <DurationBadge duration={data.metadata.duration ?? 0} className={cardClasses.chip} />
          )}
          <div className="ml-auto flex flex-col gap-2">
            <ImageContextMenu image={data} />
            <CardRemixButton image={data} />
          </div>
        </div>
      }
      footer={({ safe }) => (
        <div className="flex w-full flex-col gap-2">
          {/* In the footer, not over the media: this card's footer is painted on
              the image at the same bottom edge, so an anchored panel lands on the
              reaction counts. */}
          {safe && <RemixedCardFlyout imageId={data.id} />}
          <UserAvatarSimple
            {...data.user}
            classNames={{
              avatar: cardClasses.creatorAvatar,
              namePill: cardClasses.creatorPill,
              namePillPlate: cardClasses.creatorPillPlate,
            }}
          />
          <ImageCardActionRow data={data} />
        </div>
      )}
    />
  );
}

const countFormatter = new Intl.NumberFormat('en-US');
const MAX_COUNT_LENGTH = 9;

function ImageCardActionRow({ data }: Props) {
  const features = useFeatureFlags();
  const biggest = Math.max(
    data.stats?.likeCountAllTime ?? 0,
    data.stats?.heartCountAllTime ?? 0,
    data.stats?.laughCountAllTime ?? 0,
    data.stats?.cryCountAllTime ?? 0
  );
  const countLength = Math.min(countFormatter.format(biggest).length, MAX_COUNT_LENGTH);
  const hasMetaButton = features.imageCardInfoButton && data.hasMeta;

  return (
    <div
      className={clsx(cardClasses.actionRow, 'flex flex-wrap items-center gap-1')}
      data-count-len={Math.max(countLength, 5)}
    >
      <Reactions
        className={clsx(cardClasses.reactions, cardClasses.reactionsFill)}
        entityId={data.id}
        entityType="image"
        reactions={data.reactions}
        metricsUnknown={data.stats?.statsUnknown}
        metrics={{
          likeCount: data.stats?.likeCountAllTime,
          dislikeCount: data.stats?.dislikeCountAllTime,
          heartCount: data.stats?.heartCountAllTime,
          laughCount: data.stats?.laughCountAllTime,
          cryCount: data.stats?.cryCountAllTime,
        }}
        targetUserId={data.user.id}
        abbreviate="container"
        disableBuzzTip
      />
      {!data.poi && (
        <ImageBuzzTip
          entityId={data.id}
          targetUserId={data.user.id}
          tippedAmountCount={data.stats?.tippedAmountCountAllTime}
          metricsUnknown={data.stats?.statsUnknown}
          className={clsx(cardClasses.reactions, 'flex items-center pl-0.5')}
        />
      )}
      {(features.stickerPlacement || hasMetaButton) && (
        <div className="ml-auto flex items-center gap-1">
          {features.stickerPlacement && <StickerPlacementCardBadge imageId={data.id} />}
          {hasMetaButton && (
            <ImageMetaPopover2 imageId={data.id} type={data.type}>
              <ThemeIcon className={cardClasses.infoChip} variant="light">
                <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
              </ThemeIcon>
            </ImageMetaPopover2>
          )}
        </div>
      )}
    </div>
  );
}

type Props = { data: ImagesInfiniteModel };
