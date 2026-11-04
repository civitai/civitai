import { Button, Paper, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useJoin, useTurfGate } from '~/components/HatTurf/useHatTurf';

/** The page anchor articles link to: /events/<event>#hat-turf. */
export const HAT_TURF_ANCHOR = 'hat-turf';

/**
 * Join or leave Hat Turf from the event page. Only for a signed-in viewer on a team, while turf runs
 * for this event on a surface they can see (the same gate as the account setting).
 */
export function HatTurfEventSection({ event, team }: { event: string; team?: string }) {
  const gate = useTurfGate(!!team);
  const stock = gate.event === event ? gate.stock : undefined;
  const setOptIn = useJoin();
  const shown = !!stock;
  // The section mounts after its queries, too late for the browser's own jump to the anchor.
  const ref = useRef<HTMLDivElement>(null);
  const jumped = useRef(false);
  useEffect(() => {
    if (!shown || jumped.current || window.location.hash !== `#${HAT_TURF_ANCHOR}`) return;
    jumped.current = true;
    ref.current?.scrollIntoView({ block: 'center' });
  }, [shown]);
  if (!shown) return null;

  const joined = stock.optedIn;
  return (
    <Paper
      ref={ref}
      id={HAT_TURF_ANCHOR}
      withBorder
      radius="md"
      p="md"
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid="hat-turf-event-section"
    >
      <div>
        <Text fw={700}>Hat Turf</Text>
        <Text size="sm" c="dimmed">
          {joined
            ? "You're in. Put your team's hat on any picture to claim it for your team."
            : "Put your team's hat on any picture to claim it for your team."}
        </Text>
      </div>
      <Button
        size="sm"
        color={joined ? 'gray' : 'yellow'}
        variant={joined ? 'default' : 'filled'}
        loading={setOptIn.isPending}
        onClick={() => setOptIn.mutate({ event, optedIn: !joined })}
      >
        {joined ? 'Leave Hat Turf' : 'Join Hat Turf'}
      </Button>
    </Paper>
  );
}
