import type { ReactNode } from 'react';
import { ActionIcon, Badge, Button, Group, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { FALLBACK_COLOR } from '~/components/HatTurf/hat-turf.utils';
import { ART, FlagRacePanel } from '~/components/HatTurf/FlagRace/FlagRacePanel';
import flagClasses from '~/components/HatTurf/FlagRace/FlagRacePanel.module.scss';
import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import {
  eventHomeBlockCollapseId,
  eventHomeBlockDismissId,
  eventHomeBlockDisplay,
  flagRaceHomeKey,
} from '~/components/HomeBlocks/scored-event-home-block.utils';
import { flagsHeld, flagsPot } from '~/components/HatTurf/FlagRace/flag-race.utils';
import { HeroBulbs } from '~/components/Events/ScoredEvent/HeroBulbs';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import partyClasses from '~/components/HomeBlocks/ScoredEventHomeBlock.module.scss';
import type { FlagSummary } from '~/server/events/turf/turf.service';

/**
 * The home Flag Race row: full, shrunk to a bar, or hidden, as the event's own home block does. The
 * panel's X shrinks it, the bar's X hides it, and the event page's ShowEventHomeBlock brings it back.
 */
export function FlagRaceHomeRow({
  event,
  summary,
  children,
}: {
  event: string;
  summary: FlagSummary;
  /** Today's flags. */
  children: ReactNode;
}) {
  const { dismissed, dismiss, restore } = useNavBannersDismissed();
  const key = flagRaceHomeKey(event);
  const display = eventHomeBlockDisplay(key, dismissed);
  if (display === 'hidden') return null;
  if (display === 'collapsed')
    return (
      <HomeBlockWrapper py={16}>
        <FlagRaceCollapsedBar
          event={event}
          summary={summary}
          onExpand={() => restore(eventHomeBlockCollapseId(key))}
          onClose={() => dismiss(eventHomeBlockDismissId(key), eventHomeBlockCollapseId(key))}
        />
      </HomeBlockWrapper>
    );
  return (
    <HomeBlockWrapper py={32}>
      <div className={flagClasses.wrap}>
        <section className={clsx(partyClasses.party, flagClasses.row)}>
          <FlagRacePanel
            event={event}
            summary={summary}
            onCollapse={() => dismiss(eventHomeBlockCollapseId(key))}
          />
          {children}
        </section>
      </div>
    </HomeBlockWrapper>
  );
}

function FlagRaceCollapsedBar({
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
