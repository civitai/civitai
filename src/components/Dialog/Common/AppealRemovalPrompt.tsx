import { Anchor } from '@mantine/core';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { getAppealRefusal } from '~/shared/utils/appeal';
import type { EntityType } from '~/shared/utils/prisma/enums';
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

  const refusal = getAppealRefusal(entityType, latestAppeal);
  if (refusal) return <>{refusal}</>;

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
