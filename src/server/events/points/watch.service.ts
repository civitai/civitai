import { loadEvents } from '~/server/events/load-events';
import { isKnownHatTopic } from '~/server/events/points/award';
import { defaultMarkWatchDeps, markWatched } from '~/server/events/points/watch';

// The watch endpoint's wiring, apart from watch.ts so the pusher's import of the interest set read
// does not pull in the engine. Reads only the in-memory event registry and hat map, and sysRedis.
export async function markEventPointsWatched(input: { event: string; topics: string[] }) {
  const marked = await markWatched(
    input,
    defaultMarkWatchDeps({
      getEvent: async (name) => {
        const event = (await loadEvents()).find((e) => e.name === name);
        if (!event?.scoring) return undefined;
        return {
          name: event.name,
          startDate: event.startDate,
          endDate: event.endDate,
          finalizeAfterMs: event.scoring.finalizeAfterMs,
        };
      },
      isKnownHatTopic,
    })
  );
  return { marked };
}
