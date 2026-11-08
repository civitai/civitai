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
// A tab shown again within this long of its last mark sends none: that mark still has over a minute
// to live (watch.ts WATCH_TTL_MS), and the interval renews it. Below the refresh, so the interval's
// own marks always go out.
const SELF_WATCH_MIN_GAP_MS = 20_000;

/**
 * "All" point pops: whenever the viewer's own event total rises, from anyone's action, pops the rise.
 * Mounted once per app, it watches only for a player who joined the event, and only while the tab is
 * visible. With event cosmetics off, or the setting on "Active only", it does nothing at all: no
 * watch, no signal handler.
 */
export function EventPointsSelfPops() {
  const user = useCurrentUser();
  const showEventCosmetics = useShowEventCosmetics();
  const pops = useBrowsingSettings((x) => x.eventPointPops);
  const on = !!user && showEventCosmetics && pops === 'all';
  const definition = usePlayableEventDecoration('Image', on);
  const { data: cosmetic } = trpc.event.getCosmetic.useQuery(
    { event: definition?.event ?? '' },
    { enabled: on && !!definition, staleTime: 5 * 60_000 }
  );
  if (!on || !definition || !cosmetic?.obtained) return null;
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
  // When the last mark went out; cleared when it fails, so the next chance marks again.
  const lastMark = useRef(-Infinity);
  const { mutate } = trpc.event.watchPoints.useMutation({
    onError() {
      lastMark.current = -Infinity;
    },
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
    lastMark.current = -Infinity;
    // A hidden tab lets its mark lapse: its pushes would pop for nobody.
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastMark.current < SELF_WATCH_MIN_GAP_MS) return;
      lastMark.current = now;
      mutate({ event, topics: [], self: true });
    };
    mark();
    const id = setInterval(mark, SELF_WATCH_REFRESH_MS);
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', mark);
    };
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
