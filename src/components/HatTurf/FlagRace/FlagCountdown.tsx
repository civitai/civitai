import { useEffect, useState } from 'react';
import { Badge, Group } from '@mantine/core';
import { IconClock, IconFlagCheck, IconHourglassHigh } from '@tabler/icons-react';
import { Countdown } from '~/components/Countdown/Countdown';
import { useTeamColor } from '~/components/Events/events.utils';
import { FALLBACK_COLOR } from '~/components/HatTurf/hat-turf.utils';
import { flagClock, flagCounting } from '~/components/HatTurf/FlagRace/flag-race.utils';
import type { FlagSummary } from '~/server/events/turf/turf.service';
import { abbreviateNumber } from '~/utils/number-helpers';

/** The race's clock for a flag day, ticking each second until it closes. */
export function useFlagClock(summary: Pick<FlagSummary, 'closesAt' | 'closed'> | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!summary && !summary.closed;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return summary ? flagClock(now, summary.closesAt, summary.closed) : null;
}

/**
 * Beside the Flag Race row's title: the time to the final hour, then that the race could end any
 * moment, then once over, the points each team won (a team that won none is left out).
 */
export function FlagRaceHeader({ summary }: { summary: FlagSummary }) {
  const clock = useFlagClock(summary);
  const teamColor = useTeamColor();
  if (!clock) return null;
  if (flagCounting(summary))
    return (
      <Badge
        variant="light"
        color="gray"
        size="lg"
        radius="xl"
        leftSection={<IconHourglassHigh size={14} />}
        data-testid="flag-race-header"
      >
        Counting results…
      </Badge>
    );
  if (clock.phase === 'closed') {
    const won = Object.entries(summary.teamPoints ?? {})
      .filter(([, points]) => points > 0)
      .sort(([, a], [, b]) => b - a);
    return (
      <Group gap={6} wrap="wrap" data-testid="flag-race-header">
        <Badge
          variant="light"
          color="gray"
          size="lg"
          radius="xl"
          leftSection={<IconFlagCheck size={14} />}
        >
          Race complete
        </Badge>
        {won.map(([team, points]) => (
          <Badge
            key={team}
            size="lg"
            radius="xl"
            aria-label={`${team} won ${points} points`}
            style={{ backgroundColor: teamColor(team) ?? FALLBACK_COLOR, color: '#fff' }}
          >
            +{abbreviateNumber(points)}
          </Badge>
        ))}
      </Group>
    );
  }
  return (
    <Badge
      variant="light"
      color={clock.phase === 'final' ? 'yellow' : 'blue'}
      size="lg"
      radius="xl"
      className={clock.phase === 'final' ? 'animate-pulse' : undefined}
      leftSection={<IconClock size={14} />}
      data-testid="flag-race-header"
    >
      {clock.phase === 'final' ? (
        'Final hour: could end any moment'
      ) : (
        <>
          Final hour in{' '}
          <Countdown
            endTime={new Date(new Date(summary.closesAt).getTime() - 60 * 60 * 1000)}
            format="short"
          />
        </>
      )}
    </Badge>
  );
}
