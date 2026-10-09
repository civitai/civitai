import { getEventDecorationInWindow } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/**
 * The event decoration this viewer may put on this kind of content now, if any. The dates come from
 * the shared definitions; whether this viewer is in (flag, preview, launch) is the server's call, so
 * nothing here re-derives it. Asks nothing outside a decoration's window.
 */
export function usePlayableEventDecoration(entityType: CosmeticEntity) {
  const definition = getEventDecorationInWindow(entityType);
  const { data: access } = trpc.event.getAccess.useQuery(
    { event: definition?.event ?? '' },
    { enabled: !!definition, staleTime: 5 * 60 * 1000 }
  );
  return definition && (access === 'preview' || access === 'open') ? definition : undefined;
}
