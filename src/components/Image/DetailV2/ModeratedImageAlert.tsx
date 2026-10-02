import { Anchor } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export function ModeratedImageAlert({ imageId }: { imageId: number }) {
  const { data: latestAppeal, isLoading } = trpc.report.getLatestAppeal.useQuery({
    entityType: EntityType.Image,
    entityId: imageId,
  });
  const appealRejected = latestAppeal?.status === AppealStatus.Rejected;

  return (
    <AlertWithIcon
      icon={<IconAlertTriangle />}
      color="yellow"
      iconColor="yellow"
      title="Blocked by moderators"
      radius={0}
      px="md"
    >
      {appealRejected ? (
        'This image has been blocked by our moderators. Your appeal of this removal was reviewed and the decision stands.'
      ) : (
        <>
          This image has been blocked by our moderators. We can make mistakes, if you believe this
          was done in error,{' '}
          {isLoading ? (
            'appeal this removal'
          ) : (
            <Anchor
              type="button"
              onClick={() =>
                dialogStore.trigger({
                  component: AppealDialog,
                  props: { entityId: imageId, entityType: EntityType.Image },
                })
              }
            >
              appeal this removal
            </Anchor>
          )}
        </>
      )}
    </AlertWithIcon>
  );
}
