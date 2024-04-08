import { Text } from '@mantine/core';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';

export function QueueSnackbar() {
  const generationStatus = useGenerationStatus();
  const slots = Array(generationStatus.limits.queue).fill(0);
  const { queued, queueStatus, requestLimit, requestsRemaining } = useGenerationContext();

  const { count, quantity } = queued.reduce(
    (acc, request) => {
      acc.count += request.count;
      acc.quantity += request.quantity;
      return acc;
    },
    {
      count: 0,
      quantity: 0,
    }
  );

  return (
    <div className="flex items-center">
      <div className="flex-1">
        {queueStatus && (
          <GenerationStatusBadge status={queueStatus} count={count} quantity={quantity} />
        )}
      </div>
      <div className="flex flex-col items-center">
        <Text></Text>
        <div className="flex gap-2">
          {slots.map((slot, i) => (
            <div key={i}>i</div>
          ))}
        </div>
      </div>
      <div className="flex-1"></div>
    </div>
  );
}
