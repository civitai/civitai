import { Button } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { trpc } from '~/utils/trpc';

/** The flag Crucible taking entries now; null once its end passes, when the next one is asked for. */
export function useOpenFlagCrucible(event: string) {
  const { data: open, refetch } = trpc.hatTurf.getOpenFlagCrucible.useQuery(
    { event },
    {
      refetchInterval: 60_000,
      staleTime: 30_000,
      // Unbatched, so the edge caches it: every viewer gets the same answer.
      trpc: { context: { skipBatch: true } },
    }
  );
  const endsAtMs = open ? new Date(open.endAt).getTime() : undefined;
  const [ended, setEnded] = useState(false);
  // At its end the link goes, and the next day's Crucible is asked for, rather than linking to a
  // closed one until the next poll.
  useEffect(() => {
    setEnded(false);
    if (endsAtMs === undefined) return;
    const ms = endsAtMs - Date.now();
    if (ms <= 0) {
      setEnded(true);
      return;
    }
    const timer = setTimeout(() => {
      setEnded(true);
      void refetch();
    }, Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [endsAtMs, refetch]);
  return open && !ended ? open : null;
}

/** Links to the flag Crucible taking entries now, whose top places become the next day's flags. */
export function FlagEnterButton({ event }: { event: string }) {
  const open = useOpenFlagCrucible(event);
  if (!open) return null;
  return (
    <Link legacyBehavior href={`/crucibles/${open.id}`} passHref>
      <Button
        h={34}
        component="a"
        variant="light"
        leftSection={<IconFlag size={16} />}
        data-testid="flag-race-enter"
      >
        Enter the race
      </Button>
    </Link>
  );
}
