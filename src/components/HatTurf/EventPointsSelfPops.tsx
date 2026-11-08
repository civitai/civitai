import { useCallback, useEffect, useRef } from 'react';
import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useTeamColor } from '~/components/Events/events.utils';
import { showPointPop } from '~/components/HatTurf/PointPop';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings, useShowEventCosmetics } from '~/providers/BrowserSettingsProvider';
import { SignalMessages } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

// Matches the server's interest-set refresh (watch.ts WATCH_REFRESH_MS).
const SELF_WATCH_REFRESH_MS = 30_000;

/**
 * "All" point pops: whenever the viewer's own event total rises, from anyone's action, pops the rise.
 * Mounted once per app. With event cosmetics off, or the setting on "Active only", it does nothing at
 * all: no watch, no signal handler.
 */
export function EventPointsSelfPops() {
  const user = useCurrentUser();
  const showEventCosmetics = useShowEventCosmetics();
  const pops = useBrowsingSettings((x) => x.eventPointPops);
  const on = !!user && showEventCosmetics && pops === 'all';
  const definition = usePlayableEventDecoration('Image', on);
  if (!on || !definition) return null;
  return <SelfPops event={definition.event} />;
}

/** Reads a self push: undefined for another event or a malformed one. */
export function readSelfPush(push: unknown, event: string) {
  if (!push || typeof push !== 'object') return undefined;
  const { event: name, points } = push as { event?: unknown; points?: unknown };
  return name === event && typeof points === 'number' ? points : undefined;
}

function SelfPops({ event }: { event: string }) {
  const teamColor = useTeamColor();
  // The last total seen and the viewer's team, from the watch's answer. No pop until both are known:
  // a first push with no base would pop the whole total.
  const base = useRef<{ points: number; team: string } | undefined>(undefined);
  const { mutate } = trpc.event.watchPoints.useMutation({
    onSuccess({ self }) {
      if (!self) return;
      base.current = {
        team: self.team,
        points: Math.max(self.points, base.current?.points ?? 0),
      };
    },
  });
  useEffect(() => {
    base.current = undefined;
    const mark = () => mutate({ event, topics: [], self: true });
    mark();
    const id = setInterval(mark, SELF_WATCH_REFRESH_MS);
    return () => clearInterval(id);
  }, [event, mutate]);

  const onPush = useCallback(
    (push: unknown) => {
      const points = readSelfPush(push, event);
      const known = base.current;
      if (points === undefined || !known) return;
      const rise = points - known.points;
      if (rise <= 0) return;
      base.current = { ...known, points };
      if (document.visibilityState !== 'visible') return;
      showPointPop(
        { points: rise, team: known.team, color: teamColor(known.team) },
        { x: window.innerWidth / 2, y: window.innerHeight - 72 }
      );
    },
    [event, teamColor]
  );
  useSignalConnection(SignalMessages.EventPointsSelf, onPush);
  return null;
}
