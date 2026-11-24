import { Badge, Paper, Text } from '@mantine/core';
import { IconCalendarEvent, IconClock } from '@tabler/icons-react';
import clsx from 'clsx';
import { Countdown } from '~/components/Countdown/Countdown';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useTeamColor } from '~/components/Events/events.utils';
import { ArtPlayButton } from '~/components/Events/ScoredEvent/ArtPlayButton';
import flagClasses from '~/components/HatTurf/FlagRace/FlagRacePanel.module.scss';
import partyClasses from '~/components/HomeBlocks/ScoredEventHomeBlock.module.scss';
import { useAutoplayGifs } from '~/providers/BrowserSettingsProvider';
import type { ComebackPace } from '~/server/events/scoring/comeback-pace';
import { trpc } from '~/utils/trpc';
import classes from './ComebackCupSection.module.scss';

// The Cup cover's landscape crop; the flagRace key's media.comeback.art replaces it.
export const COMEBACK_ART = 'a3bb0527-fa08-4f85-af90-36bc4778c832';
const DAY_MS = 24 * 60 * 60 * 1000;

const utcDay = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const signed = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`;
// The bar's share of the track: own pace at half, twice it full.
const barWidth = (pct: number) => Math.max(3, Math.min(100, (100 + pct) / 2));

/** The event page's Comeback Cup: each team's final week so far against its own pace. */
export function ComebackCupSection({
  event,
  myTeam,
  teamHats,
}: {
  event: string;
  myTeam?: string;
  teamHats?: { team: string; url: string | null }[];
}) {
  // Unbatched, so the edge caches them: every viewer gets the same answer.
  const { data } = trpc.hatTurf.getComebackPace.useQuery(
    { event },
    { staleTime: 5 * 60_000, trpc: { context: { skipBatch: true } } }
  );
  const { data: media } = trpc.hatTurf.getEventMedia.useQuery(
    { event },
    { staleTime: 5 * 60_000, trpc: { context: { skipBatch: true } } }
  );
  if (!data) return null;
  return (
    <ComebackCupCard
      pace={data}
      myTeam={myTeam}
      teamHats={teamHats}
      art={media?.comeback?.art ?? COMEBACK_ART}
      video={media?.comeback?.video}
      duration={media?.comeback?.duration}
    />
  );
}

export function ComebackCupCard({
  pace,
  myTeam,
  teamHats,
  art = COMEBACK_ART,
  video,
  duration,
  now = new Date(),
}: {
  pace: ComebackPace;
  myTeam?: string;
  teamHats?: { team: string; url: string | null }[];
  art?: string;
  /** The Cup film's URL or CDN id; absent shows no play button. */
  video?: string;
  /** The film's length in seconds. */
  duration?: number;
  now?: Date;
}) {
  const teamColor = useTeamColor();
  const autoplay = useAutoplayGifs();
  const from = new Date(pace.week.from);
  const to = new Date(pace.week.to);
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  const day = Math.min(days, Math.floor((now.getTime() - from.getTime()) / DAY_MS) + 1);
  const ended = now >= to;
  // A team with no points this week reads -100%; until one has some, there is no race to show.
  const started = pace.teams.some((t) => t.pct > -100);

  return (
    <div className={flagClasses.wrap} data-testid="comeback-cup-section">
      <section className={clsx(partyClasses.party, classes.card)}>
        <EdgeMedia src={art} width={520} alt="" className={classes.art} />
        {video && (
          <ArtPlayButton
            video={video}
            title="Comeback Cup"
            duration={duration}
            testId="comeback-cup"
            className={classes.play}
          />
        )}
        <div className="relative z-[1]">
          <p className={flagClasses.title}>Comeback Cup</p>
          <p className={flagClasses.tag}>
            Beat your own pace. <b>Win the Cup.</b>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge
              tt="none"
              variant="light"
              color="yellow"
              size="lg"
              radius="xl"
              leftSection={<IconClock size={14} />}
            >
              {ended ? (
                'Final week over'
              ) : (
                <>
                  Day {day} of {days} · <Countdown endTime={to} format="short" /> left
                </>
              )}
            </Badge>
            <Badge
              tt="none"
              variant="light"
              color="gray"
              size="lg"
              radius="xl"
              leftSection={<IconCalendarEvent size={14} />}
            >
              <span className="hidden @sm:inline">
                {utcDay(from)} to {utcDay(new Date(to.getTime() - DAY_MS))} ·{' '}
              </span>
              Ends {utcDay(to)} 00:00 UTC
            </Badge>
          </div>
          <div className={clsx(flagClasses.label, 'flex justify-between gap-2')}>
            <span>Against its own pace</span>
            <span className="hidden @sm:inline">Updates through the day</span>
          </div>
          {!started && (
            <Text size="sm" c="dimmed" mb="xs" data-testid="comeback-cup-empty">
              The race shows once this week&apos;s first points settle.
            </Text>
          )}
          <div className="flex flex-col gap-2">
            {pace.teams.map((t, index) => {
              const color = teamColor(t.team) ?? 'gray';
              const mine = t.team === myTeam;
              const below = t.pct < 0;
              const hat = teamHats?.find((h) => h.team === t.team)?.url;
              return (
                <Paper
                  key={t.team}
                  withBorder
                  radius="md"
                  px={12}
                  py={10}
                  className="flex items-center gap-2.5 bg-white/5"
                  data-mine={mine || undefined}
                  data-below={below || undefined}
                  data-testid="comeback-cup-team"
                  style={{
                    borderColor: mine ? color : 'rgba(255,255,255,0.1)',
                    boxShadow: mine ? `0 0 18px -4px ${color}` : undefined,
                  }}
                >
                  <Text fw={700} fz={16} w={24} ta="center" c="dimmed" className="shrink-0">
                    {started ? index + 1 : '–'}
                  </Text>
                  <div className="size-8 shrink-0">
                    {hat && <EdgeMedia src={hat} width={64} alt="" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <Text fw={700} size="sm" c={color} className="whitespace-nowrap">
                        Team {t.team}
                        {started && index === 0 && (
                          <span className="ml-1 text-[11px] font-extrabold uppercase tracking-wider text-yellow-5">
                            · Leading
                          </span>
                        )}
                      </Text>
                      <span
                        className={clsx(
                          'whitespace-nowrap font-extrabold tabular-nums',
                          below ? 'text-gray-4' : 'text-white'
                        )}
                      >
                        {started ? signed(t.pct) : '–'}
                        <small className="ml-1 hidden text-xs font-medium text-dark-1 @sm:inline">
                          vs own pace
                        </small>
                      </span>
                    </div>
                    <div className={classes.track}>
                      {started && (
                        <i
                          style={{
                            width: `${barWidth(t.pct)}%`,
                            backgroundColor: color,
                            opacity: below ? 0.55 : 1,
                          }}
                        />
                      )}
                      <b />
                    </div>
                  </div>
                </Paper>
              );
            })}
          </div>
          <div className={classes.explainer}>
            {pace.badge && (
              <EdgeMedia
                src={pace.badge.url}
                width={128}
                anim={pace.badge.animated && autoplay}
                optimized
                alt=""
                className="size-16 shrink-0 object-contain"
              />
            )}
            <span>
              The team that improves most on its own pace wins the Cup.{' '}
              <b>
                Any member of the winning team whose hats earned points this week gets the badge.
              </b>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
