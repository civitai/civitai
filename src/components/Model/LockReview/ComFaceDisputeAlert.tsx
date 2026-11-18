import { Alert, Button, Group, Text } from '@mantine/core';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LockReviewDialog } from '~/components/Model/LockReview/LockReviewDialog';
import {
  COM_FACE_INTENT_DISPUTE_PENDING_MESSAGE,
  COM_FACE_INTENT_LOCK_MESSAGE,
} from '~/shared/utils/model-sfw-face';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

/** On the civitai.com tab while the listing intent check's lock is on: why, and the Dispute button. */
export function ComFaceDisputeAlert({ modelId }: { modelId: number }) {
  const { data } = trpc.report.getLockReviewState.useQuery({ id: modelId });
  if (!data?.comFaceIntent) return null;

  return (
    <Alert color="yellow" p="xs" mb="md">
      <Text size="xs">
        {data.pending ? COM_FACE_INTENT_DISPUTE_PENDING_MESSAGE : COM_FACE_INTENT_LOCK_MESSAGE}
      </Text>
      {data.reopensAt ? (
        <Text size="xs" c="dimmed" mt={4}>
          This was reviewed recently. You can dispute it again on {formatDate(data.reopensAt)}.
        </Text>
      ) : (
        !data.pending && (
          <Group mt="xs">
            <Button
              size="compact-xs"
              variant="light"
              onClick={() =>
                dialogStore.trigger({
                  component: LockReviewDialog,
                  props: { modelId, dispute: true },
                })
              }
            >
              Dispute
            </Button>
          </Group>
        )
      )}
    </Alert>
  );
}

/** Who set a requestable nsfw lock, for the editor's lock line. */
export function NsfwLockSource({ modelId }: { modelId: number }) {
  const { data } = trpc.report.getLockReviewState.useQuery({ id: modelId });
  return (
    <>{data?.comFaceIntent ? 'Locked by our civitai.com listing check' : 'Locked by moderator'}</>
  );
}
