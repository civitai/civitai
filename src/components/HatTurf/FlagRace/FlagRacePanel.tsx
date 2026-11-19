import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Badge, Group, Text, UnstyledButton } from '@mantine/core';
import {
  IconArrowRight,
  IconClock,
  IconConfetti,
  IconFlag,
  IconHelpCircle,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { Countdown } from '~/components/Countdown/Countdown';
import { useTeamColor } from '~/components/Events/events.utils';
import { FALLBACK_COLOR } from '~/components/HatTurf/hat-turf.utils';
import { FlagRaceHeader } from '~/components/HatTurf/FlagRace/FlagCountdown';
import { useOpenFlagCrucible } from '~/components/HatTurf/FlagRace/FlagEnterButton';
import { flagsHeld, flagsPot } from '~/components/HatTurf/FlagRace/flag-race.utils';
import type { FlagSummary } from '~/server/events/turf/turf.service';
import { abbreviateNumber } from '~/utils/number-helpers';
import classes from './FlagRacePanel.module.scss';

export const ART_ID = '5064a196-aa66-4c07-bb2a-f3f2ccbacef1';
const ART = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${ART_ID}/width=900,optimized=true/${ART_ID}.jpeg`;
const RULES_ARTICLE = '/articles/38657';
export const HOWTO_DISMISSED_KEY = 'flag-race-howto-dismissed';

function useHowtoDismissed() {
  // Unknown (null) until mounted, so neither the box nor its pill flashes before the device's choice is read.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(HOWTO_DISMISSED_KEY) === '1');
    } catch {}
  }, []);
  const set = (value: boolean) => {
    setDismissed(value);
    try {
      if (value) localStorage.setItem(HOWTO_DISMISSED_KEY, '1');
      else localStorage.removeItem(HOWTO_DISMISSED_KEY);
    } catch {}
  };
  return [dismissed, set] as const;
}

/** The Flag Race row's side panel: the race's clock, what is at stake, who holds what, and the way in. */
export function FlagRacePanel({
  event,
  summary,
  onCollapse,
}: {
  event: string;
  summary: FlagSummary;
  /** Renders a collapse X; omit to hide it. */
  onCollapse?: () => void;
}) {
  const teamColor = useTeamColor();
  const [dismissed, setDismissed] = useHowtoDismissed();
  const held = flagsHeld(summary.flags);
  const pot = flagsPot(summary.flags);
  const next = useOpenFlagCrucible(event);

  return (
    <div className={classes.panel} data-testid="flag-race-panel">
      <img className={classes.art} src={ART} alt="" />
      {onCollapse && (
        <ActionIcon
          variant="filled"
          color="dark"
          radius="xl"
          className="!absolute right-3 top-3 z-[7] opacity-80"
          aria-label="Collapse the Flag Race"
          onClick={onCollapse}
        >
          <IconX size={14} />
        </ActionIcon>
      )}
      <div className={classes.artSpace} />
      <div className={classes.head}>
        <div className={classes.titles}>
          <p className={classes.title}>Flag Race</p>
          <p className={classes.tag}>
            Stack hats. <b>Win the flag.</b>
          </p>
        </div>
        {next && (
          <Link
            href={`/crucibles/${next.id}`}
            className={classes.enter}
            data-testid="flag-race-enter"
          >
            {next.coverUrl && <img src={getEdgeUrl(next.coverUrl, { width: 96 })} alt="" />}
            <span className="min-w-0">
              <b className="block text-[13px]">Enter tomorrow&apos;s flags</b>
              <small>
                Today&apos;s Crucible · <Countdown endTime={new Date(next.endAt)} format="short" />{' '}
                left
              </small>
            </span>
            <IconArrowRight size={18} className="ml-auto shrink-0" />
          </Link>
        )}
      </div>
      <div className={classes.bar}>
        <div className={classes.pills}>
          <FlagRaceHeader summary={summary} />
          {!summary.closed && pot > 0 && (
            <Badge
              tt="none"
              variant="light"
              color="yellow"
              size="lg"
              radius="xl"
              leftSection={<IconTrophy size={14} />}
              data-testid="flag-race-pot"
            >
              {abbreviateNumber(pot)} points up for grabs
            </Badge>
          )}
          {dismissed === true && (
            <UnstyledButton onClick={() => setDismissed(false)}>
              <Badge
                tt="none"
                variant="light"
                color="gray"
                size="lg"
                radius="xl"
                className="cursor-pointer"
                leftSection={<IconHelpCircle size={14} />}
              >
                How it works
              </Badge>
            </UnstyledButton>
          )}
        </div>

        {!summary.closed && (
          <div className={classes.held}>
            <div className={classes.label}>Flags held right now</div>
            {held.length ? (
              <Group gap={6} data-testid="flag-race-held">
                {held.map(([team, count]) => (
                  <Badge
                    tt="none"
                    key={team}
                    size="lg"
                    radius="xl"
                    aria-label={`${team} holds ${count} ${count === 1 ? 'flag' : 'flags'}`}
                    style={{ backgroundColor: teamColor(team) ?? FALLBACK_COLOR, color: '#fff' }}
                  >
                    {count}
                  </Badge>
                ))}
              </Group>
            ) : (
              <Text size="sm" c="dimmed" data-testid="flag-race-held">
                Nobody yet. Be the first.
              </Text>
            )}
          </div>
        )}
      </div>

      {dismissed === false && (
        <div className={classes.howto} data-testid="flag-race-howto">
          <ActionIcon
            variant="subtle"
            color="gray"
            radius="xl"
            size="sm"
            className="!absolute right-1.5 top-1.5"
            aria-label="Hide how it works"
            onClick={() => setDismissed(true)}
          >
            <IconX size={14} />
          </ActionIcon>
          <div className={classes.steps}>
            <div className={classes.step}>
              <span className={classes.stepIcon}>
                <IconFlag size={13} />
              </span>
              <span>
                <b>10 new flags</b> every day
              </span>
            </div>
            <div className={classes.step}>
              <span className={classes.stepIcon}>
                <IconConfetti size={13} />
              </span>
              <span>
                <b>Most hats</b> on a flag wins it
              </span>
            </div>
            <div className={classes.step}>
              <span className={classes.stepIcon}>
                <IconClock size={13} />
              </span>
              <span>
                Ends at a <b>secret moment</b>
              </span>
            </div>
          </div>
          <Link
            href={RULES_ARTICLE}
            className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-blue-2"
          >
            Full rules in the article <IconArrowRight size={12} />
          </Link>
        </div>
      )}
    </div>
  );
}
