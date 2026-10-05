import { Card, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { IconTrophy, IconCoin, IconMedal, IconChartBar, IconAward } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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
  // Starts dismissed so the server render and returning visitors never flash the intro before
  // localStorage is read.
  const [introDismissed, setIntroDismissed] = useState(true);

  useEffect(() => {
    try {
      setIntroDismissed(localStorage.getItem(INTRO_DISMISSED_KEY) === '1');
    } catch {
      setIntroDismissed(false);
    }
  }, []);

  const dismissIntro = () => {
    setIntroDismissed(true);
    try {
      localStorage.setItem(INTRO_DISMISSED_KEY, '1');
    } catch {}
  };

  const isFirstTimer = !currentUser || (!isLoading && (stats?.totalCrucibles ?? 0) === 0);
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
          Here&apos;s how you&apos;re doing in your active crucibles
        </Text>
      </Stack>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={<IconTrophy size={24} />}
          iconColor="blue"
          label="Total Crucibles"
          value={stats?.totalCrucibles ?? 0}
          isLoading={isLoading}
        />
        <StatCard
          icon={<IconCoin size={24} />}
          iconColor="yellow"
          label="Buzz Won"
          value={stats?.buzzWon ?? 0}
          isLoading={isLoading}
          formatValue={(v) => numberWithCommas(v ?? 0)}
        />
        <StatCard
          icon={<IconMedal size={24} />}
          iconColor="orange"
          label="Best Placement"
          value={stats?.bestPlacement}
          isLoading={isLoading}
          formatValue={(v) => (v !== null && v !== undefined ? `#${v}` : '-')}
        />
        <StatCard
          icon={<IconChartBar size={24} />}
          iconColor="green"
          label="Avg Finish"
          value={stats?.avgFinishTopPercent}
          isLoading={isLoading}
          formatValue={(v) => (v !== null && v !== undefined ? `Top ${v}%` : '-')}
        />
        <StatCard
          icon={<IconAward size={24} />}
          iconColor="yellow"
          label="Prizes Won"
          value={stats?.prizesWon ?? 0}
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
      </Stack>
    </Card>
  );
}
