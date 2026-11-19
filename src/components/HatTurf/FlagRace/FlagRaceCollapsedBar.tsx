import { ActionIcon, Badge, Button, Group, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { FALLBACK_COLOR } from '~/components/HatTurf/hat-turf.utils';
import { ART } from '~/components/HatTurf/FlagRace/FlagRacePanel';
import { flagsHeld, flagsPot } from '~/components/HatTurf/FlagRace/flag-race.utils';
import { HeroBulbs } from '~/components/Events/ScoredEvent/HeroBulbs';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import partyClasses from '~/components/HomeBlocks/ScoredEventHomeBlock.module.scss';
import type { FlagSummary } from '~/server/events/turf/turf.service';

/** The Flag Race row's key in the event home block's collapse/hide cookie entries, apart from the event's own block. */
export const flagRaceHomeKey = (event: string) => `${event}:flags`;

export function FlagRaceCollapsedBar({
  event,
  summary,
  onExpand,
  onClose,
}: {
  event: string;
  summary: FlagSummary;
  onExpand: () => void;
  onClose: () => void;
}) {
  const teamColor = useTeamColor();
  const held = summary.closed ? [] : flagsHeld(summary.flags);
  const pot = flagsPot(summary.flags);
  // The same query (and cache entry) the event's own home block reads for its bulbs.
  const { data } = trpc.event.getData.useQuery({ event });
  const colors = (data?.teams ?? []).map((t) => teamColor(t)).filter((c): c is string => !!c);

  return (
    <div
      className={clsx(partyClasses.party, 'flex items-center gap-3 rounded-2xl p-2 pr-3')}
      data-testid="flag-race-collapsed"
    >
      <HeroBulbs colors={colors} count={22} />
      <img
        src={ART}
        alt=""
        className="relative z-[3] h-10 w-[60px] shrink-0 rounded-lg object-cover"
      />
      <Text size="sm" className="relative z-[3] min-w-0 flex-1 truncate">
        <b>Flag Race</b> ·{' '}
        {summary.closed
          ? 'Counting today’s flags'
          : pot > 0
          ? `${abbreviateNumber(pot)} points up for grabs`
          : `${summary.flags.length} flags up today`}
      </Text>
      {held.length > 0 && (
        <Group gap={4} wrap="nowrap" className="relative z-[3] hidden sm:flex">
          {held.map(([team, count]) => (
            <Badge
              tt="none"
              key={team}
              radius="xl"
              aria-label={`${team} holds ${count} ${count === 1 ? 'flag' : 'flags'}`}
              style={{ backgroundColor: teamColor(team) ?? FALLBACK_COLOR, color: '#fff' }}
            >
              {count}
            </Badge>
          ))}
        </Group>
      )}
      <Button
        size="compact-sm"
        radius="xl"
        variant="white"
        color="dark"
        className="relative z-[3]"
        onClick={onExpand}
      >
        Show
      </Button>
      <ActionIcon
        variant="subtle"
        color="gray"
        className="relative z-[3]"
        aria-label="Hide the Flag Race"
        onClick={onClose}
      >
        <IconX size={16} />
      </ActionIcon>
    </div>
  );
}
