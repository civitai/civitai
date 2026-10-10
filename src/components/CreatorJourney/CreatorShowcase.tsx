import { ActionIcon, Skeleton, Text, Title, Tooltip } from '@mantine/core';
import { IconCalendarCheck, IconCrown, IconEyeOff, IconSparkles } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { legendStatusLabel, showcaseMonthLabel } from '~/components/CreatorJourney/legend-status';
import { useShowcaseOptOut } from '~/components/CreatorJourney/ShowcaseOptOutSetting';
import { accentVar, TierBadge, tierAccents } from '~/components/CreatorJourney/tier-badge';
import {
  SpotlightBorderCard,
  SpotlightDivider,
  SpotlightGlow,
  SpotlightSurface,
} from '~/components/SpotlightCard/SpotlightBorderCard';
import { Username } from '~/components/User/Username';
import { UserAvatar, UserProfileLink } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Showcase = RouterOutput['creatorJourney']['getShowcase'];
type ShowcaseUser = Showcase['legends'][number]['user'];

const SUPERNOVA = { key: 'score:supernova', accent: tierAccents['score:supernova'] };
const LEGEND = { key: 'score:legend', accent: tierAccents['score:legend'] };
const HIDE_LABEL = 'Hide me from the showcase';

export function CreatorShowcase() {
  const { data, isLoading } = trpc.creatorJourney.getShowcase.useQuery();
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery();
  const badgeUrl = (key: string) => ladder?.tiers.find((tier) => tier.key === key)?.badgeUrl;
  const { setHidden, isPending: hiding } = useShowcaseOptOut({
    onHidden: () =>
      showSuccessNotification({
        message:
          "You're hidden from the Creator Showcase. You can turn it back on in your account settings.",
      }),
  });

  return (
    <CreatorShowcaseView
      showcase={data}
      isLoading={isLoading}
      supernovaArt={badgeUrl(SUPERNOVA.key)}
      legendArt={badgeUrl(LEGEND.key)}
      onHide={() => setHidden(true)}
      hiding={hiding}
    />
  );
}

export function CreatorShowcaseView({
  showcase: data,
  isLoading,
  supernovaArt,
  legendArt,
  onHide,
  hiding,
}: {
  showcase?: Showcase;
  isLoading?: boolean;
  supernovaArt?: string | null;
  legendArt?: string | null;
  onHide?: () => void;
  hiding?: boolean;
}) {
  const currentUser = useCurrentUser();
  const month = showcaseMonthLabel(new Date());

  return (
    <div className="flex flex-col gap-10">
      <Hero supernovaArt={supernovaArt} legendArt={legendArt} />

      {isLoading ? (
        <ShowcaseSkeleton />
      ) : !data ? (
        <Text c="dimmed">The showcase couldn&apos;t load. Try again in a few minutes.</Text>
      ) : (
        <>
          <ShowcaseSection
            accent={SUPERNOVA.accent}
            art={supernovaArt}
            name="Supernova"
            title={`New Supernovas in ${month}`}
            description="Creators who reached a Creator Score of 1,000,000 this month."
            count={data.newSupernovas.length}
            empty={`No new Supernovas yet in ${month}. The next one could be you.`}
          >
            {data.newSupernovas.map(({ user, achievedAt }) => (
              <ShowcaseCreatorCard
                key={user.id}
                user={user}
                accent={SUPERNOVA.accent}
                isViewer={user.id === currentUser?.id}
                onHide={onHide}
                hiding={hiding}
                icon={<IconCalendarCheck size={14} />}
                label={`Reached ${formatDate(achievedAt, 'MMM D', true)}`}
              />
            ))}
          </ShowcaseSection>

          <ShowcaseSection
            accent={LEGEND.accent}
            art={legendArt}
            name="Legend"
            title="Hall of Fame"
            description="Every creator who has reached Legend, a Creator Score of 10,000,000."
            count={data.legends.length}
            empty="No Legends yet. The first one will be remembered here."
          >
            {data.legends.map(({ user, founding, since }) => (
              <ShowcaseCreatorCard
                key={user.id}
                user={user}
                accent={LEGEND.accent}
                isViewer={user.id === currentUser?.id}
                onHide={onHide}
                hiding={hiding}
                icon={<IconCrown size={14} />}
                label={legendStatusLabel({ founding, since })}
                highlight={founding}
              />
            ))}
          </ShowcaseSection>
        </>
      )}
    </div>
  );
}

function Hero({
  supernovaArt,
  legendArt,
}: {
  supernovaArt?: string | null;
  legendArt?: string | null;
}) {
  return (
    <SpotlightSurface color={LEGEND.accent} className="rounded-xl bg-gray-3 p-px dark:bg-dark-4">
      <SpotlightGlow size={560} duration={300} className="inset-0 rounded-[inherit]" />
      <div className="relative overflow-hidden rounded-[calc(0.75rem-1px)] bg-white dark:bg-dark-7">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-30 dark:opacity-35"
          style={{
            background: `radial-gradient(90% 120% at 0% 0%, ${SUPERNOVA.accent} 0%, transparent 60%), radial-gradient(80% 120% at 100% 100%, ${LEGEND.accent} 0%, transparent 65%)`,
          }}
        />
        <SpotlightGlow
          size={640}
          fade={65}
          color={`color-mix(in srgb, ${SUPERNOVA.accent} 50%, transparent)`}
        />
        <div className="relative flex flex-col items-center gap-6 p-6 text-center sm:flex-row sm:p-8 sm:text-left">
          <div className="relative flex shrink-0 items-end">
            <GlowBadge art={supernovaArt} name="Supernova" accent={SUPERNOVA.accent} size={104} />
            <GlowBadge
              art={legendArt}
              name="Legend"
              accent={LEGEND.accent}
              size={128}
              className="-ml-6"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Text size="xs" tt="uppercase" c="dimmed" fw={700} className="tracking-widest">
              Creator Journey
            </Text>
            <Title order={1} className="text-4xl sm:text-5xl">
              Creator Showcase
            </Title>
            <Text c="dimmed" maw={560}>
              Celebrating the creators at the top of the ladder. Supernovas who broke through this
              month, and the Legends who made it all the way.
            </Text>
          </div>
        </div>
      </div>
    </SpotlightSurface>
  );
}

function ShowcaseSection({
  accent,
  art,
  name,
  title,
  description,
  count,
  empty,
  children,
}: {
  accent: string;
  art?: string | null;
  name: string;
  title: string;
  description: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <SpotlightSurface color={accent} className="flex flex-col gap-4" style={accentVar(accent)}>
      <SpotlightGlow
        size={640}
        fade={60}
        color="color-mix(in srgb, var(--cj-accent) 10%, transparent)"
        className="-inset-4 rounded-2xl"
      />
      <div className="flex items-center gap-3">
        <TierBadge badgeUrl={art} name={name} state="earned" size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Title order={2} size="h3">
              {title}
            </Title>
            {count > 0 && (
              <span
                className="rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
                style={{ background: 'var(--cj-accent)' }}
              >
                {count} {count === 1 ? 'creator' : 'creators'}
              </span>
            )}
          </div>
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        </div>
      </div>
      <div
        aria-hidden
        className="relative h-px w-full"
        style={{ background: 'linear-gradient(90deg, var(--cj-accent), transparent 80%)' }}
      >
        <SpotlightDivider overlay size={220} />
      </div>
      {count > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">{children}</div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-gray-4 px-4 py-10 text-center dark:border-dark-4">
          <TierBadge
            badgeUrl={art}
            name={name}
            state="earned"
            size={56}
            className="opacity-40 grayscale"
          />
          <Text size="sm" c="dimmed">
            {empty}
          </Text>
        </div>
      )}
    </SpotlightSurface>
  );
}

function ShowcaseCreatorCard({
  user,
  accent,
  isViewer,
  icon,
  label,
  highlight,
  onHide,
  hiding,
}: {
  user: ShowcaseUser;
  accent: string;
  isViewer?: boolean;
  onHide?: () => void;
  hiding?: boolean;
  icon: ReactNode;
  label: string;
  highlight?: boolean;
}) {
  return (
    <SpotlightBorderCard
      color={accent}
      size={300}
      className="group/card motion-safe:transition-transform motion-safe:duration-300 motion-safe:hover:-translate-y-0.5"
      style={accentVar(accent)}
      faceClassName="flex flex-col items-center gap-3 p-4 pt-5 text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-28 opacity-25"
        style={{
          background: 'radial-gradient(60% 100% at 50% 0%, var(--cj-accent) 0%, transparent 100%)',
        }}
      />
      {isViewer && (
        <>
          <span
            className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
            style={{ background: 'var(--cj-accent)' }}
          >
            You
          </span>
          {onHide && (
            <Tooltip label={HIDE_LABEL} withArrow withinPortal>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                className="absolute right-2 top-2"
                aria-label={HIDE_LABEL}
                loading={hiding}
                onClick={onHide}
              >
                <IconEyeOff size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </>
      )}
      <div
        className="relative rounded-full p-[3px] shadow-[0_0_18px_color-mix(in_srgb,var(--cj-accent)_45%,transparent)] group-hover/card:shadow-[0_0_30px_color-mix(in_srgb,var(--cj-accent)_75%,transparent)] motion-safe:transition-[box-shadow,transform] motion-safe:duration-300 motion-safe:group-hover/card:scale-105"
        style={{ background: 'linear-gradient(160deg, var(--cj-accent), transparent 85%)' }}
      >
        <UserAvatar user={user} avatarSize={72} radius="xl" linkToProfile withHoverCard={false} />
      </div>
      <div className="relative flex min-w-0 max-w-full justify-center [&_a]:text-inherit [&_a]:no-underline">
        <UserProfileLink user={user} linkToProfile>
          <Username {...user} size="md" badgeSize={20} />
        </UserProfileLink>
      </div>
      <div className="mt-auto flex w-full flex-col items-center gap-2">
        <SpotlightDivider />
        <div
          className={clsx(
            'flex items-center justify-center gap-1.5 text-balance text-center text-xs [&_svg]:shrink-0',
            highlight
              ? 'font-bold uppercase tracking-wide brightness-75 dark:brightness-100'
              : 'text-gray-6 dark:text-dark-2'
          )}
          style={highlight ? { color: 'var(--cj-accent)' } : undefined}
        >
          {highlight ? <IconSparkles size={14} /> : icon}
          {label}
        </div>
      </div>
    </SpotlightBorderCard>
  );
}

function GlowBadge({
  art,
  name,
  accent,
  size,
  className,
}: {
  art?: string | null;
  name: string;
  accent: string;
  size: number;
  className?: string;
}) {
  return (
    <div className={clsx('relative', className)} style={accentVar(accent)}>
      <div
        aria-hidden
        className="absolute inset-0 scale-110 rounded-full opacity-50 blur-2xl"
        style={{ background: 'var(--cj-accent)' }}
      />
      <TierBadge badgeUrl={art} name={name} state="earned" size={size} className="relative" />
    </div>
  );
}

function ShowcaseSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton height={48} width="40%" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={190} radius="md" />
        ))}
      </div>
    </div>
  );
}
