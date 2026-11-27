import { IconAlertTriangle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppealRemovalPrompt } from '~/components/Dialog/Common/AppealRemovalPrompt';
import { NextLink } from '~/components/NextLink/NextLink';
import { isAppealableImage } from '~/shared/utils/appeal';
import { EntityType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export const IMAGE_REMOVED_TITLE = 'Removed from public view';
export const IMAGE_REMOVED_TEXT = "This image isn't visible to other users.";

type NoticeImage = {
  id: number;
  blockedFor?: string | null;
  needsReview?: string | null;
  createdAt?: Date | string | null;
  postId?: number | null;
};

/**
 * Rendered for the owner; shows only on a blocked image. The appeal link appears only when the server would
 * accept one; every other block, whatever its cause, gets the same notice.
 */
export function OwnerBlockedImageNotice({ image }: { image: NoticeImage }) {
  const appealable = isAppealableImage(image);
  const { data, isError } = trpc.image.getAppealState.useQuery(
    { id: image.id },
    { enabled: appealable }
  );

  if (appealable && data?.canAppeal)
    return (
      <AlertWithIcon
        icon={<IconAlertTriangle />}
        color="yellow"
        iconColor="yellow"
        title="Blocked by moderators"
        radius={0}
        px="md"
      >
        This image has been blocked by our moderators.{' '}
        <AppealRemovalPrompt entityId={image.id} entityType={EntityType.Image} />
        <WhichImage image={image} />
      </AlertWithIcon>
    );

  if (!image.blockedFor) return null;
  // An error can't rule out that the appeal would be refused, so it reads as a refusal.
  if (!appealable || data || isError)
    return (
      <AlertWithIcon
        icon={<IconAlertTriangle />}
        color="yellow"
        iconColor="yellow"
        title={IMAGE_REMOVED_TITLE}
        radius={0}
        px="md"
      >
        {IMAGE_REMOVED_TEXT}
        <WhichImage image={image} />
      </AlertWithIcon>
    );

  return null;
}

/**
 * Tells the owner which image the notice is about, since its media is withheld from them too. Only
 * what the row carries whatever the block, so it never reads differently by reason.
 */
function WhichImage({ image: { createdAt, postId } }: { image: NoticeImage }) {
  if (!createdAt && !postId) return null;
  return (
    <span className="mt-1 block text-xs">
      {createdAt && <>Uploaded {formatDate(createdAt)}</>}
      {createdAt && postId && ', '}
      {postId && (
        <>
          {createdAt ? 'in ' : 'In '}
          <NextLink href={`/posts/${postId}`} className="underline">
            post #{postId}
          </NextLink>
        </>
      )}
    </span>
  );
}
