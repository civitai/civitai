import { Anchor } from '@mantine/core';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { EntityType } from '~/shared/utils/prisma/enums';
import { AppealStatus } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export function AppealRemovalPrompt({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: EntityType;
}) {
  const { data: latestAppeal, isLoading } = trpc.report.getLatestAppeal.useQuery({
    entityId,
    entityType,
  });

  if (latestAppeal?.status === AppealStatus.Rejected)
    return <>Your appeal of this removal was reviewed and the decision stands.</>;

  return (
    <>
      We can make mistakes. If you believe this was done in error,{' '}
      {isLoading ? (
        'appeal this removal'
      ) : (
        <Anchor
          type="button"
          onClick={() =>
            dialogStore.trigger({ component: AppealDialog, props: { entityId, entityType } })
          }
        >
          appeal this removal
        </Anchor>
      )}
      .
    </>
  );
}
