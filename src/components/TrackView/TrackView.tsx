import { useEffect, useRef } from 'react';
import { AddViewSchema } from '~/server/schema/track.schema';
import { trpc } from '~/utils/trpc';

export function TrackView({ type, entityType, entityId }: AddViewSchema) {
  const trackMutation = trpc.track.addView.useMutation();
  const observedEntityId = useRef<number | null>(null);

  useEffect(() => {
    console.log({ entityId, observed: observedEntityId.current });
    if (entityId !== observedEntityId.current) {
      observedEntityId.current = entityId;
      trackMutation.mutate({
        type,
        entityType,
        entityId,
      });
    }
  }, [entityId, type, entityType]);

  return null;
}
