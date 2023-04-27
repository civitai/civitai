import { useEffect, useRef } from 'react';
import { AddViewSchema } from '~/server/schema/track.schema';
import { trpc } from '~/utils/trpc';

export function TrackView({ type, entityType, entityId }: AddViewSchema) {
  const trackMutation = trpc.track.addView.useMutation();
  const didRender = useRef(false);

  useEffect(() => {
    if (!didRender.current) {
      trackMutation.mutate({
        type,
        entityType,
        entityId,
      });

      didRender.current = true;
    }
  }, []);

  return null;
}
