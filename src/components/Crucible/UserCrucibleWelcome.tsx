import { Card, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import clsx from 'clsx';
import { IconTrophy, IconCoin, IconMedal, IconChartBar, IconThumbUp } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIntroDismissed } from '~/hooks/useIntroDismissed';
import { numberWithCommas } from '~/utils/number-helpers';
import type { RouterOutput } from '~/types/router';
import { ActiveCruciblesCarousel } from './ActiveCruciblesCarousel';
import { CrucibleIntro } from './CrucibleIntro';

const INTRO_DISMISSED_KEY = 'crucible-intro-dismissed';

export function UserCrucibleWelcome() {
  const currentUser = useCurrentUser();
  const { data: stats, isLoading } = trpc.crucible.getUserStats.useQuery(
    {},
    { enabled: !!currentUser }
  );
  const [introDismissed, dismissIntro] = useIntroDismissed(INTRO_DISMISSED_KEY);

  const isFirstTimer = !currentUser || (!isLoading && (stats?.cruciblesEntered ?? 0) === 0);
  if (isFirstTimer && !introDismissed)
    return <CrucibleIntro canCreate={!!currentUser} onDismiss={dismissIntro} />;
  if (!currentUser) return null;

  return (
    <UserCrucibleWelcomeContent
      username={currentUser.username ?? 'there'}
      stats={stats}
      isLoading={isLoading}
    />
  );
}

function UserCrucibleWelcomeContent({
  username,
  stats,
  isLoading,
}: {
  username: string;
  stats: RouterOutput['crucible']['getUserStats'] | undefined;
  isLoading: boolean;
}) {
  return (
    <Card
      radius="md"
      className="mb-8 border border-[#373a40]"
      style={{
        background: 'linear-gradient(135deg, #25262b 0%, #1a1b1e 100%)',
      }}
      p="xl"
    >
      {/* User greeting */}
      <Stack gap="sm" mb="lg">
        <Text fz="xl" fw={700} c="white">
          Welcome back, {username}!
        </Text>
        <Text size="sm" c="dimmed">
          Your crucible record
        </Text>
      </Stack>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={<IconTrophy size={24} />}
          iconColor="blue"
          label="Crucibles Entered"
          value={stats?.cruciblesEntered ?? 0}
          isLoading={isLoading}
        />
        <StatCard
          icon={<IconCoin size={24} />}
          iconColor="yellow"
          label="Buzz Won"
          value={stats?.buzzWon ?? 0}
          isLoading={isLoading}
          formatValue={(v) => numberWithCommas(v ?? 0)}
          hint={stats ? `${stats.cruciblesWon} of ${stats.cruciblesEnded} won` : undefined}
          showEndedNote
        />
        <StatCard
          icon={<IconMedal size={24} />}
          iconColor="orange"
          label="Best Finish"
          value={stats?.bestFinish?.position}
          isLoading={isLoading}
          formatValue={(v) =>
            v !== null && v !== undefined && stats?.bestFinish
              ? `#${v} of ${numberWithCommas(stats.bestFinish.fieldSize)}`
              : '-'
          }
          showEndedNote
        />
        <StatCard
          icon={<IconChartBar size={24} />}
          iconColor="green"
          label="Avg Finish"
          value={stats?.avgFinishTopPercent}
          isLoading={isLoading}
          formatValue={(v) => (v !== null && v !== undefined ? `Top ${v}%` : '-')}
          showEndedNote
        />
        <StatCard
          icon={<IconThumbUp size={24} />}
          iconColor="yellow"
          label="Votes Cast"
          value={stats?.votesCast ?? 0}
          isLoading={isLoading}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {/* Active Crucibles Carousel */}
      <ActiveCruciblesCarousel />
    </Card>
  );
}

type StatCardProps = {
  icon: React.ReactNode;
  iconColor: 'blue' | 'yellow' | 'orange' | 'green';
  label: string;
  value: number | null | undefined;
  isLoading: boolean;
  formatValue?: (value: number | null | undefined) => string;
  /** Small line under the value, e.g. a win rate. */
  hint?: string;
  /** Marks a card that only counts ended crucibles, so 0 reads as "nothing ended yet". */
  showEndedNote?: boolean;
  className?: string;
};

const iconColorMap = {
  blue: 'text-blue-500',
  yellow: 'text-yellow-500',
  orange: 'text-orange-500',
  green: 'text-green-500',
};

function StatCard({
  icon,
  iconColor,
  label,
  value,
  isLoading,
  formatValue,
  hint,
  showEndedNote,
  className,
}: StatCardProps) {
  const displayValue = formatValue ? formatValue(value) : numberWithCommas(value ?? 0);

  return (
    <Card
      radius="md"
      className={clsx('border border-[#373a40] transition-all hover:border-blue-500', className)}
      style={{
        background: 'rgba(37, 38, 43, 0.5)',
      }}
      p="md"
    >
      <Stack align="center" gap="xs">
        <ThemeIcon variant="transparent" size="lg" className={iconColorMap[iconColor]}>
          {icon}
        </ThemeIcon>
        <Text size="xs" c="dimmed" tt="uppercase" ta="center" style={{ letterSpacing: '0.05em' }}>
          {label}
        </Text>
        {isLoading ? (
          <Skeleton height={28} width={60} />
        ) : (
          <Text fz="xl" fw={700} c="white" ta="center">
            {displayValue}
          </Text>
        )}
        {(hint || showEndedNote) && (
          <Stack gap={0} align="center">
            {hint && !isLoading && (
              <Text size="xs" c="dimmed" ta="center">
                {hint}
              </Text>
            )}
            {showEndedNote && (
              <Text size="xs" c="dimmed" ta="center" opacity={0.7}>
                From ended crucibles
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
