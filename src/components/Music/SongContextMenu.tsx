import type { ActionIconProps } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconBookmark,
  IconExternalLink,
  IconFlag,
  IconRadar2,
  IconScale,
  IconShare3,
  IconTrash,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openRatingReviewModal } from '~/components/Dialog/triggers/rating-review';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { ImageContextMenuWrapper } from '~/components/Image/ContextMenu/ContextMenu';
import { useImageContextMenuContext } from '~/components/Image/ContextMenu/ImageContextMenuProvider';
import type { ImageContextMenuProps } from '~/components/Image/ContextMenu/ImageMenuItems';
import { useDeleteImage } from '~/components/Image/hooks/useDeleteImage';
import { useReportTosViolation } from '~/components/Image/hooks/useReportTosViolation';
import { useRescanImage } from '~/components/Image/hooks/useRescanImage';
import { useReportCsamImages } from '~/components/Image/image.utils';
import { useImageContext } from '~/components/Image/ImageProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Menu } from '~/components/MantineOverlays';
import { ModeratorLookupMenuItem } from '~/components/Moderation/ModeratorLookupMenuItem';
import { NextLink } from '~/components/NextLink/NextLink';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ratingDisputeEnabled } from '~/server/schema/rating-review.schema';
import { songDisputable } from '@civitai/shared/rating-review';
import {
  moderatorBulkImageManagerPath,
  moderatorImageLookupPath,
} from '~/shared/constants/moderator-app';
import { CollectionType } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { RemoveSongCoverMenuItem } from '~/components/Music/RemoveSongCoverMenuItem';
import { storedSongDurationSec } from '~/shared/utils/song-play';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

type SongContextMenuProps = {
  image: ImageContextMenuProps['image'];
  /** The play items for the list the song is shown in (`SongMenuItems`). */
  leadingMenuItems?: ReactNode;
  /** The page's own items (the detail view's Download), after Open song. */
  additionalMenuItems?: ReactNode;
};

/** Shares the song's page: the system share sheet where there is one, else its link copied. */
async function shareSong(imageId: number, onCopied: (url: string) => void) {
  const url = `${location.protocol}//${location.host}/images/${imageId}`;
  if (navigator.share) {
    try {
      await navigator.share({ url });
    } catch {
      // Dismissed: nothing was shared.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // No clipboard (an insecure context, or permission refused): say so rather than fail silently.
    showErrorNotification({ title: 'Couldn’t copy the link', error: new Error(url) });
    return;
  }
  onCopied(url);
  showSuccessNotification({
    title: 'Link copied',
    message: 'The song’s link is on your clipboard.',
  });
}

/** The owner's "Dispute rating": only on a song its own scans have reviewed, the one a moderator
 *  may rule on. A card that does not carry the song's state leaves the check to the server. */
export function canDisputeSongRating({
  isOwner,
  features,
  ingestion,
}: {
  isOwner: boolean;
  features: Parameters<typeof ratingDisputeEnabled>[0];
  ingestion?: string;
}) {
  return (
    isOwner &&
    ratingDisputeEnabled(features, 'Song') &&
    (ingestion === undefined || songDisputable(ingestion))
  );
}

/**
 * A song's ⋯ menu (Pencil `rUDmm`): play, save to a playlist, share, open and report, with the
 * owner's rating dispute and delete, and the moderator tools that apply to a song. Image-only actions (showcase,
 * decorations, minor/POI flags, storylines, More like this) are not offered.
 */
function SongMenuItems({ image, leadingMenuItems, additionalMenuItems }: SongContextMenuProps) {
  const router = useRouter();
  const { isOwner, isModerator } = useImageContext();
  const features = useFeatureFlags();
  const { trackShare } = useTrackEvent();
  const { additionalMenuItemsAfter, additionalMenuItemsBefore } = useImageContextMenuContext();
  const { id: imageId, postId, user, userId } = image;
  const ownerId = user?.id ?? userId;
  const deleteImage = useDeleteImage();
  const rescanImage = useRescanImage();
  const reportTos = useReportTosViolation();
  const reportCsamMutation = useReportCsamImages();
  const onSongPage = router.pathname.startsWith('/images/');
  // A collection's own page removes from the collection, not the site.
  const canDelete = !router.pathname.includes('/collections');

  const handleReportCsam = () => {
    if (!ownerId) return;
    if (features.csamReports)
      window.open(`/moderator/csam/${ownerId}?imageId=${imageId}`, '_blank');
    else reportCsamMutation.mutate({ imageIds: [imageId] });
  };

  return (
    <>
      {additionalMenuItemsBefore?.(image)}
      {leadingMenuItems}
      {postId && (
        <LoginRedirect reason="add-to-collection">
          <Menu.Item
            leftSection={<IconBookmark size={16} stroke={1.5} />}
            onClick={() =>
              openAddToCollectionModal({ props: { imageId, type: CollectionType.Music } })
            }
          >
            Save to playlist
          </Menu.Item>
        </LoginRedirect>
      )}
      <Menu.Item
        leftSection={<IconShare3 size={16} stroke={1.5} />}
        onClick={() => shareSong(imageId, (url) => trackShare({ platform: 'clipboard', url }))}
      >
        Share
      </Menu.Item>
      {!onSongPage && (
        <Menu.Item
          component={NextLink}
          href={`/images/${imageId}`}
          leftSection={<IconExternalLink size={16} stroke={1.5} />}
        >
          Open song
        </Menu.Item>
      )}
      {additionalMenuItems}
      {!isOwner && (
        <>
          <Menu.Divider />
          <LoginRedirect reason="report-content">
            <Menu.Item
              color="red"
              leftSection={<IconFlag size={16} stroke={1.5} />}
              onClick={() =>
                openReportModal({
                  entityType: ReportEntity.Image,
                  entityId: imageId,
                  song: { durationSec: storedSongDurationSec(image.metadata?.duration) },
                })
              }
            >
              Report song
            </Menu.Item>
          </LoginRedirect>
          <HideImageButton as="menu-item" imageId={imageId} noun="song" />
          {ownerId && <HideUserButton as="menu-item" userId={ownerId} />}
          {ownerId && <BlockUserButton userId={ownerId} as="menu-item" />}
        </>
      )}
      {canDisputeSongRating({ isOwner, features, ingestion: image.ingestion }) && (
        <>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconScale size={16} stroke={1.5} />}
            onClick={() =>
              openRatingReviewModal({
                entityType: 'Song',
                entityId: imageId,
                currentLevel: image.nsfwLevel,
              })
            }
          >
            Dispute rating
          </Menu.Item>
        </>
      )}
      {(isOwner || isModerator) && canDelete && (
        <>
          <Menu.Divider />
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={16} stroke={1.5} />}
            onClick={() => deleteImage({ imageId })}
          >
            Delete song
          </Menu.Item>
        </>
      )}
      {additionalMenuItemsAfter?.(image)}
      {isModerator && (
        <>
          <Menu.Label>Moderator</Menu.Label>
          <ModeratorLookupMenuItem path={moderatorImageLookupPath(imageId)}>
            Lookup song
          </ModeratorLookupMenuItem>
          {postId && (
            <ModeratorLookupMenuItem path={moderatorBulkImageManagerPath('post', postId)}>
              Lookup post
            </ModeratorLookupMenuItem>
          )}
          <Menu.Item
            leftSection={<IconBan size={16} stroke={1.5} />}
            onClick={() => reportTos({ imageId })}
          >
            Remove as ToS violation
          </Menu.Item>
          <RemoveSongCoverMenuItem songId={imageId} />
          <Menu.Item
            leftSection={<IconRadar2 size={16} stroke={1.5} />}
            onClick={() => rescanImage({ imageId })}
          >
            Rescan song
          </Menu.Item>
          <Menu.Item
            leftSection={<IconAlertTriangle size={16} stroke={1.5} />}
            onClick={handleReportCsam}
          >
            Report CSAM
          </Menu.Item>
        </>
      )}
    </>
  );
}

/** A song's ⋯ trigger and menu, in the shared context-menu shell. */
export function SongContextMenu({
  image,
  leadingMenuItems,
  additionalMenuItems,
  ...actionIconProps
}: SongContextMenuProps & ActionIconProps) {
  return (
    <ImageContextMenuWrapper image={image} aria-label="Song options" {...actionIconProps}>
      <SongMenuItems
        image={image}
        leadingMenuItems={leadingMenuItems}
        additionalMenuItems={additionalMenuItems}
      />
    </ImageContextMenuWrapper>
  );
}
