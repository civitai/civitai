import { CloseButton, Text } from '@mantine/core';
import { IconFlag, IconShare3 } from '@tabler/icons-react';
import type { ComponentProps, ReactNode } from 'react';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { Gated } from '~/components/Gated/Gated';
import { imageDetailGateLevel } from '~/components/Image/DetailV2/image-detail-gate';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ImageGetById } from '~/types/router';
import { ReportEntity } from '~/shared/utils/report-helpers';

export type ReviewWork = NonNullable<ImageGetById['reviewWork']>;
type DetailImage = ComponentProps<typeof ImageGuard2>['image'] & {
  id: number;
  url: string;
  nsfwLevel: number;
  user: { id: number; username: string | null };
};

const actionIconProps = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 w-9 rounded-full',
} as const;

/**
 * An image a buyer attached to their review of a service: the seller's work. It can be viewed and
 * reported, nothing else: no reactions, comments, collecting, remixing, download or generation data,
 * and no OG image or structured data. The seller is credited, with Follow and a tip to them.
 */
export function ReviewWorkImageDetail({
  image,
  reviewWork,
  close,
  shareUrl,
  stage,
}: {
  image: DetailImage;
  reviewWork: ReviewWork;
  close: () => void;
  shareUrl: string;
  /** The carousel showing the image. */
  stage: ReactNode;
}) {
  const currentUser = useCurrentUser();
  const { seller } = reviewWork;
  const title = seller?.username ? `Work by ${seller.username}` : 'Work from a service review';

  return (
    <Gated
      contentNsfwLevel={imageDetailGateLevel(image)}
      bypassRating={currentUser?.id === image.user.id || !!currentUser?.isModerator}
      meta={{ title, canonical: `/images/${image.id}`, deIndex: true }}
    >
      <BrowsingLevelProvider browsingLevel={image.nsfwLevel}>
        <div
          className="flex size-full max-h-full max-w-full flex-col overflow-hidden bg-gray-2 @md:flex-row dark:bg-dark-9"
          data-testid="review-work-image-detail"
        >
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ImageGuard2 image={image} explain={false}>
              {() => (
                <>
                  <div className="flex justify-between gap-3 p-3">
                    <div className="flex items-center gap-1">
                      <CloseButton
                        onClick={close}
                        variant="filled"
                        className="size-9 rounded-full"
                        data-testid="image-detail-close"
                      />
                      <ImageGuard2.BlurToggle
                        variant="filled"
                        color="gray"
                        className="h-9 min-w-9 rounded-full normal-case"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <ShareButton url={shareUrl} title={title}>
                        <LegacyActionIcon {...actionIconProps} aria-label="Share">
                          <IconShare3 size={18} color="white" />
                        </LegacyActionIcon>
                      </ShareButton>
                      <LoginRedirect reason="report-content">
                        <LegacyActionIcon
                          {...actionIconProps}
                          aria-label="Report"
                          onClick={() =>
                            openReportModal({ entityType: ReportEntity.Image, entityId: image.id })
                          }
                        >
                          <IconFlag size={18} color="white" />
                        </LegacyActionIcon>
                      </LoginRedirect>
                    </div>
                  </div>
                  <div className="relative flex min-h-0 flex-1 flex-col">{stage}</div>
                </>
              )}
            </ImageGuard2>
          </div>
          <div className="flex w-full flex-col gap-3 p-3 @md:w-[360px]">
            {seller && <SmartCreatorCard user={seller} className="rounded-xl" tipsEnabled />}
            <Text size="sm" c="dimmed">
              {image.user.username
                ? `Shared by ${image.user.username} in a review of this creator's service.`
                : "Shared in a review of this creator's service."}
            </Text>
          </div>
        </div>
      </BrowsingLevelProvider>
    </Gated>
  );
}
