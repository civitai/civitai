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
import { flagsHeld, flagsPot } from '~/components/HatTurf/FlagRace/flag-race.utils';
import type { FlagSummary } from '~/server/events/turf/turf.service';
import { abbreviateNumber } from '~/utils/number-helpers';
import classes from './FlagRacePanel.module.scss';

const ART =
  'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/5064a196-aa66-4c07-bb2a-f3f2ccbacef1/width=900,optimized=true/5064a196-aa66-4c07-bb2a-f3f2ccbacef1.jpeg';
const RULES_ARTICLE = '/articles/38657';
export const HOWTO_DISMISSED_KEY = 'flag-race-howto-dismissed';

function useHowtoDismissed() {
  // Starts open on the server and the first paint, then reads the device's choice.
  const [dismissed, setDismissed] = useState(false);
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
export function FlagRacePanel({ summary }: { summary: FlagSummary }) {
  const teamColor = useTeamColor();
  const [dismissed, setDismissed] = useHowtoDismissed();
  const held = flagsHeld(summary.flags);
  const pot = flagsPot(summary.flags);
  const next = summary.nextCrucible;

  return (
    <div className={classes.panel} data-testid="flag-race-panel">
      <img className={classes.art} src={ART} alt="" />
      <div className={classes.artSpace} />
      <p className={classes.title}>Flag Race</p>
      <p className={classes.tag}>
        Stack hats. <b>Win the flag.</b>
      </p>
      <div className="relative mt-2.5 flex flex-col items-start gap-1.5">
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
      </div>

      {dismissed && (
        <div className="mt-3">
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
        </div>
      )}

      {!summary.closed && (
        <>
          <div className={classes.label}>Flags held right now</div>
          {held.length ? (
            <Group gap={6} wrap="nowrap" data-testid="flag-race-held">
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
        </>
      )}

      {!dismissed && (
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
          <div className="grid gap-2">
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

      {next && (
        <>
          <div className="mt-auto" />
          <Link
            href={`/crucibles/${next.id}`}
            className={classes.enter}
            data-testid="flag-race-enter"
          >
            {next.coverUrl && <img src={getEdgeUrl(next.coverUrl, { width: 96 })} alt="" />}
            <span className="min-w-0">
              <b className="block text-[13px]">Enter tomorrow&apos;s flags</b>
              {next.endAt && (
                <small>
                  Today&apos;s Crucible ·{' '}
                  <Countdown endTime={new Date(next.endAt)} format="short" /> left
                </small>
              )}
            </span>
            <IconArrowRight size={18} className="ml-auto shrink-0" />
          </Link>
        </>
      )}
    </div>
  );
}
