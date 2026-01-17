import { Card, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconTrophy, IconCoin, IconMedal, IconChartBar } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * UserCrucibleWelcome - Welcome section with user crucible stats
 *
 * Shows personalized greeting and stats for logged-in users:
 * - Total Crucibles entered
 * - Buzz Won from prizes
 * - Best Placement (position number)
 * - Win Rate percentage
 *
 * Only renders for authenticated users.
 * Reference: docs/features/crucible/mockups/discovery.html
 */
export function UserCrucibleWelcome() {
  const currentUser = useCurrentUser();

  // Only show for logged-in users
  if (!currentUser) return null;

  return <UserCrucibleWelcomeContent username={currentUser.username ?? 'there'} />;
}

function UserCrucibleWelcomeContent({ username }: { username: string }) {
  const { data: stats, isLoading } = trpc.crucible.getUserStats.useQuery({});

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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
          formatValue={(v) => abbreviateNumber(v ?? 0)}
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
          label="Win Rate"
          value={stats?.winRate ?? 0}
          isLoading={isLoading}
          formatValue={(v) => `${v ?? 0}%`}
        />
      </div>
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
};

const iconColorMap = {
  blue: 'text-blue-500',
  yellow: 'text-yellow-500',
  orange: 'text-orange-500',
  green: 'text-green-500',
};

function StatCard({ icon, iconColor, label, value, isLoading, formatValue }: StatCardProps) {
  const displayValue = formatValue ? formatValue(value) : String(value ?? 0);

  return (
    <Card
      radius="md"
      className="border border-[#373a40] transition-all hover:border-blue-500"
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
