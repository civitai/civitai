import { useEffect, useRef } from 'react';
import { AddViewSchema } from '~/server/schema/track.schema';
import { trpc } from '~/utils/trpc';

export function TrackView({ type, entityType, entityId, details }: AddViewSchema) {
  const trackMutation = trpc.track.addView.useMutation();
  const observedEntityId = useRef<number | null>(null);

  useEffect(() => {
    if (entityId !== observedEntityId.current) {
      observedEntityId.current = entityId;
      trackMutation.mutate({
        type,
        entityType,
        entityId,
        details,
      });
    }
  }, [entityId, type, entityType, details]);

  return null;
}
