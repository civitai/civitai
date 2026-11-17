import { getEventAccess, type EventViewer } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { isKnownHatTopic } from '~/server/events/points/award';
import { listedOwnerTopics } from '~/server/events/points/roster';
import { getOwnerPoints } from '~/server/events/points/read';
import { defaultMarkWatchDeps, markWatched } from '~/server/events/points/watch';

// The watch endpoint's wiring, apart from watch.ts so the pusher's import of the interest set read
// does not pull in the engine. Reads only the in-memory event registry and hat map, in-process Flipt
// (for the preview's access), and sysRedis.
export async function markEventPointsWatched(
  input: { event: string; topics: string[]; self?: boolean },
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
      selfUserId: viewer?.id,
      listedOwnerTopics: async (name, topicIds) =>
        new Set((await listedOwnerTopics(name, topicIds)).keys()),
      canWatchPreview: async (name) => {
        const event = await findScored(name);
        return !!event && (await getEventAccess(event, viewer)) === 'preview';
      },
    })
  );
  // The caller's own total, so their screen has a base to pop the next push's rise against.
  if (!marked || !input.self || !viewer?.id) return { marked };
  const event = await findScored(input.event);
  if (!event) return { marked };
  const [totals, team] = await Promise.all([
    getOwnerPoints(event, [viewer.id]).catch(() => undefined),
    event.getUserTeam(viewer.id).catch(() => undefined),
  ]);
  if (!totals || !team) return { marked };
  return { marked, self: { points: totals[String(viewer.id)] ?? 0, team } };
}
