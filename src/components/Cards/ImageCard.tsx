import { ActionIcon } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { Reactions } from '~/components/Reaction/Reactions';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { RemixButton } from '~/components/Cards/components/RemixButton';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';

export function ImageCard({ data }: Props) {
  const context = useImagesContext();

  return (
    <AspectRatioImageCard
      style={{
        '--aspect-ratio': data.width && data.height ? data.width / data.height : 1,
      }}
      image={data}
      cosmetic={data.cosmetic?.data}
      routedDialog={{ name: 'imageDetail', state: { imageId: data.id, ...context } }}
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
            {data.hasMeta && (
              <ImageMetaPopover2 imageId={data.id} type={data.type}>
                <ActionIcon className={cardClasses.infoChip} variant="light">
                  <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
                </ActionIcon>
              </ImageMetaPopover2>
            )}
          </div>
        </div>
      }
    />
  );
}

type Props = { data: ImagesInfiniteModel };
