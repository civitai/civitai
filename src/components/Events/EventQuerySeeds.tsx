import type { EventSeed } from '~/server/services/event-seeds.service';
import { trpc } from '~/utils/trpc';

/**
 * Primes `event.getAccess` and `event.getCosmetic` from the server render's answers
 * (`event-seeds.service.ts`), so `usePlayableEventDecoration` and the point pops read a filled
 * cache instead of asking on every page load.
 *
 * Each seed is a `useQuery` with the consumers' own procedure and input, so it lands under their
 * exact key. `enabled: false`: it only seeds and never fetches, so a missing seed costs nothing
 * here and the consumers fetch for themselves as before. A seed applies only to a query not yet in
 * the cache (React Query's `initialData`), so it never replaces fresher data.
 */
export function EventQuerySeeds({ seeds }: { seeds?: EventSeed[] }) {
  if (!seeds?.length) return null;
  return (
    <>
      {seeds.map((seed) => (
        <EventQuerySeed key={seed.event} seed={seed} />
      ))}
    </>
  );
}

function EventQuerySeed({ seed: { event, access, cosmetic } }: { seed: EventSeed }) {
  trpc.event.getAccess.useQuery({ event }, { initialData: access, enabled: false });
  trpc.event.getCosmetic.useQuery({ event }, { initialData: cosmetic, enabled: false });
  return null;
}
