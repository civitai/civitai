import { getEventAccess, type EventViewer } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { isKnownHatTopic } from '~/server/events/points/award';
import { defaultMarkWatchDeps, markWatched } from '~/server/events/points/watch';

// The watch endpoint's wiring, apart from watch.ts so the pusher's import of the interest set read
// does not pull in the engine. Reads only the in-memory event registry and hat map, in-process Flipt
// (for the preview's access), and sysRedis.
export async function markEventPointsWatched(
  input: { event: string; topics: string[] },
  viewer: EventViewer
) {
  const findScored = async (name: string) => {
    const event = (await loadEvents()).find((e) => e.name === name);
    return event?.scoring ? event : undefined;
  };
  const marked = await markWatched(
    input,
    defaultMarkWatchDeps({
      getEvent: async (name) => {
        const event = await findScored(name);
        if (!event?.scoring) return undefined;
        return {
          name: event.name,
          previewFrom: event.previewFrom,
          startDate: event.startDate,
          endDate: event.endDate,
          finalizeAfterMs: event.scoring.finalizeAfterMs,
        };
      },
      isKnownHatTopic,
      canWatchPreview: async (name) => {
        const event = await findScored(name);
        return !!event && (await getEventAccess(event, viewer)) === 'preview';
      },
    })
  );
  return { marked };
}
