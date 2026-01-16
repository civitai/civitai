import { IconInfoCircle } from '@tabler/icons-react';
import { ThemeIcon } from '@mantine/core';
import { Reactions } from '~/components/Reaction/Reactions';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { RemixButton } from '~/components/Cards/components/RemixButton';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { MetricSubscriptionProvider, useLiveMetrics } from '~/components/Metrics';
import cardClasses from '~/components/Cards/Cards.module.css';

export function ImageCard({ data }: Props) {
  return (
    <MetricSubscriptionProvider entityType="Image" entityId={data.id}>
      <ImageCardContent data={data} />
    </MetricSubscriptionProvider>
  );
}

function ImageCardContent({ data }: Props) {
  const { getImages, ...context } = useImagesContext();

  const liveMetrics = useLiveMetrics('Image', data.id, {
    likeCount: data.stats?.likeCountAllTime ?? 0,
    dislikeCount: data.stats?.dislikeCountAllTime ?? 0,
    heartCount: data.stats?.heartCountAllTime ?? 0,
    laughCount: data.stats?.laughCountAllTime ?? 0,
    cryCount: data.stats?.cryCountAllTime ?? 0,
    tippedAmountCount: data.stats?.tippedAmountCountAllTime ?? 0,
  });

  return (
    <AspectRatioImageCard
      image={data}
      cosmetic={data.cosmetic?.data}
      routedDialog={{
        name: 'imageDetail',
        state: { imageId: data.id, images: getImages(), ...context },
      }}
      header={
        <div className="flex w-full items-start justify-between">
          {data.type === 'video' && data.metadata && 'duration' in data.metadata && (
            <DurationBadge duration={data.metadata.duration ?? 0} className={cardClasses.chip} />
          )}
          <div className="ml-auto flex flex-col gap-2">
            <ImageContextMenu image={data} />
            <RemixButton type={data.type} id={data.id} canGenerate={data.hasMeta} />
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
              metrics={liveMetrics}
              targetUserId={data.user.id}
              disableBuzzTip={data.poi}
            />
            {data.hasMeta && (
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
