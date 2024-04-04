import { Text } from '@mantine/core';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import {
  useGenerationQueueStore,
  useGetGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerationRequestStatus } from '~/server/common/enums';

export function QueueSnackbar() {
  const { requests, images } = useGenerationQueueStore();
  const count = requests.flatMap((x) => x.images ?? []).filter((x) => !x.duration).length;
  const status = requests.some((x) => x.status === GenerationRequestStatus.Processing)
    ? GenerationRequestStatus.Processing
    : requests[0].status;

  const { quantity, succeededCount, cancelledCount, errorCount } = requests.reduce(
    (acc, request) => ({
      quantity: acc.quantity + request.quantity,
      succeededCount:
        acc.succeededCount + request.status === GenerationRequestStatus.Succeeded ? 1 : 0,
      cancelledCount:
        acc.cancelledCount + request.status === GenerationRequestStatus.Cancelled ? 1 : 0,
      errorCount: acc.errorCount + request.status === GenerationRequestStatus.Error ? 1 : 0,
    }),
    { quantity: 0, succeededCount: 0, cancelledCount: 0, errorCount: 0 }
  );

  return (
    <div className="flex items-center">
      <div className="flex-1">
        <GenerationStatusBadge status={status} count={count} quantity={quantity} />
      </div>
      <div className="flex flex-col items-center">
        <Text></Text>
        <div className="flex gap-2"></div>
      </div>
      <div className="flex-1"></div>
    </div>
  );
}
