import { useState } from 'react';
import { Popover, Text } from '@mantine/core';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import classes from '~/components/HatTurf/HatTurfCountChip.module.css';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import { teamStandings } from '~/components/HatTurf/hat-turf.utils';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import { abbreviateNumber } from '~/utils/number-helpers';

const FALLBACK = 'var(--mantine-color-gray-6)';

/** The count-button arm's standings: the image's hat total, opening every team's count. */
export function HatTurfCountChip({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  if (!feed || feed.arm !== 'count-button' || feed.open[imageId] === false) return null;
  return <HatTurfCountChipContent imageId={imageId} />;
}

function HatTurfCountChipContent({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const teamColor = useTeamColor();
  const track = useHatTurfAction('feed-card');
  const [open, setOpen] = useState(false);
  if (!feed) return null;

  const { rows, total, lead, toTake } = teamStandings(
    summary ?? { counted: {}, leader: null },
    feed.team
  );
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK;
  const leadColor = lead ? colorOf(lead) : FALLBACK;

  return (
    <Popover opened={open} onChange={setOpen} withinPortal position="top-end" withArrow shadow="md">
      <Popover.Target>
        <button
          type="button"
          className={clsx(classes.chip, open && classes.open)}
          style={{ '--lead': leadColor } as React.CSSProperties}
          aria-label={`${total} hats on this image${lead ? `, ${lead} leads` : ''}. Show teams`}
          aria-expanded={open}
          data-testid="hat-turf-count-chip"
          onClick={(event) => {
            // The card is a link and this sits inside it.
            event.preventDefault();
            event.stopPropagation();
            if (!open) track('hat_count_open', feed.event);
            setOpen(!open);
          }}
        >
          <span className={classes.dot}>
            <HatIcon size={9} />
          </span>
          {abbreviateNumber(total)}
        </button>
      </Popover.Target>
      <Popover.Dropdown
        p="sm"
        w={224}
        onClick={(event) => event.stopPropagation()}
        data-testid="hat-turf-count-popover"
      >
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
          Hats on this image
        </Text>
        {!rows.length && <Text size="sm">No hats yet. Be the first.</Text>}
        {rows.map(({ team, count }) => (
          <div
            key={team}
            className={clsx(classes.row, team === feed.team && classes.mine)}
            data-team={team}
          >
            <span className={classes.swatch} style={{ backgroundColor: colorOf(team) }} />
            <span className={classes.name}>
              {team}
              {team === feed.team && <span className={classes.you}> · you</span>}
            </span>
            <span className={classes.bar}>
              <i
                style={{
                  width: `${rows[0].count ? (count / rows[0].count) * 100 : 0}%`,
                  backgroundColor: colorOf(team),
                }}
              />
            </span>
            <span className={classes.count}>{abbreviateNumber(count)}</span>
          </div>
        ))}
        {lead && (
          <Text size="xs" className={classes.note} data-testid="hat-turf-count-note">
            {lead} holds this image.
            {toTake !== null && (
              <>
                {' '}
                {feed.team} needs <b>{toTake} more</b> to take it.
              </>
            )}
          </Text>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
