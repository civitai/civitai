import { IconAlertTriangle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppealRemovalPrompt } from '~/components/Dialog/Common/AppealRemovalPrompt';
import { EntityType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/** Shown to the owner of a moderator-blocked image. The appeal link appears only when the server would accept one. */
export function OwnerBlockedImageNotice({ imageId }: { imageId: number }) {
  const { data, isError } = trpc.image.getAppealState.useQuery({ id: imageId });

  if (data?.canAppeal)
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
        <AppealRemovalPrompt entityId={imageId} entityType={EntityType.Image} />
      </AlertWithIcon>
    );

  // An error can't rule out that the appeal would be refused, so it reads as a refusal.
  if (data || isError)
    return (
      <AlertWithIcon
        icon={<IconAlertTriangle />}
        color="yellow"
        iconColor="yellow"
        radius={0}
        px="md"
      >
        This image has been removed from public view and can&apos;t be appealed.
      </AlertWithIcon>
    );

  return null;
}
