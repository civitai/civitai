import { Card, Grid, Group, Paper, Skeleton, Stack } from '@mantine/core';

const premiumCardStyle: React.CSSProperties = {
  background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
  boxShadow: 'light-dark(0 1px 3px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.4))',
};

export function ReferralDashboardSkeleton() {
  return (
    <Stack gap="lg">
      {/* Title row: ThemeIcon + title + subtitle */}
      <Group gap="sm" align="flex-start" wrap="nowrap">
        <Skeleton height={44} width={44} circle />
        <Stack gap={6} className="flex-1">
          <Skeleton height={30} width={220} radius="sm" />
          <Skeleton height={14} width="85%" radius="sm" />
        </Stack>
      </Group>

      {/* Code block — two-column with gradient divider */}
      <Paper radius="md" withBorder style={premiumCardStyle} className="overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr]">
          <Stack gap="md" p="lg">
            <Skeleton height={12} width={140} radius="sm" />
            <Group gap={8} wrap="nowrap" align="center">
              <Skeleton height={48} width={220} radius="md" />
              <Skeleton height={36} width={36} circle />
            </Group>
          </Stack>
          <div className="hidden w-[3px] bg-gray-100 sm:block dark:bg-white/5" />
          <div className="block h-px bg-gray-100 sm:hidden dark:bg-white/5" />
          <Stack gap={8} p="lg">
            <Skeleton height={12} width={80} radius="sm" />
            <Group gap="xs" wrap="wrap">
              <Skeleton height={28} width={100} radius="md" />
              <Skeleton height={28} width={110} radius="md" />
              <Skeleton height={28} width={130} radius="md" />
              <Skeleton height={28} width={130} radius="md" />
            </Group>
          </Stack>
        </div>
      </Paper>

      {/* How it works — 4 cards with gradient header + circle icon */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Skeleton height={20} width={140} radius="sm" />
          <Grid>
            {[0, 1, 2, 3].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 6, md: 3 }}>
                <Paper withBorder radius="md" p={0} className="overflow-hidden">
                  <div className="flex items-center justify-center p-6">
                    <Skeleton height={64} width={64} circle />
                  </div>
                  <Stack gap={6} p="md" align="center">
                    <Skeleton height={14} width={100} radius="sm" />
                    <Skeleton height={12} width="90%" radius="sm" />
                    <Skeleton height={12} width="70%" radius="sm" />
                  </Stack>
                </Paper>
              </Grid.Col>
            ))}
          </Grid>
        </Stack>
      </Card>

      {/* Rank card — premium */}
      <Paper radius="md" withBorder style={premiumCardStyle} p="lg">
        <Stack gap="lg">
          <Group gap="md" wrap="nowrap">
            <Skeleton height={64} width={64} radius="md" />
            <Stack gap={6} className="flex-1">
              <Skeleton height={12} width={80} radius="sm" />
              <Skeleton height={32} width={180} radius="sm" />
              <Skeleton height={12} width={260} radius="sm" />
            </Stack>
          </Group>
          <Stack gap={8}>
            <Group justify="space-between">
              <Skeleton height={12} width={100} radius="sm" />
              <Skeleton height={12} width={80} radius="sm" />
            </Group>
            <Skeleton height={16} radius="xl" />
            <Skeleton height={14} width="50%" radius="sm" />
          </Stack>
          <Grid>
            {[0, 1, 2].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 4 }}>
                <StatBlockSkeleton />
              </Grid.Col>
            ))}
          </Grid>
        </Stack>
      </Paper>

      {/* Blue Buzz milestones */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Skeleton height={20} width={160} radius="sm" />
          <Grid>
            {[0, 1].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 6 }}>
                <StatBlockSkeleton />
              </Grid.Col>
            ))}
          </Grid>
          <Skeleton height={56} radius="md" />
          <Stack gap="xs">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={60} radius="md" />
            ))}
          </Stack>
        </Stack>
      </Card>

      {/* Token Shop */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Stack gap={6}>
            <Skeleton height={20} width={180} radius="sm" />
            <Skeleton height={14} width="55%" radius="sm" />
          </Stack>
          <Skeleton height={56} radius="md" />
          <Grid>
            {[0, 1].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 6 }}>
                <StatBlockSkeleton />
              </Grid.Col>
            ))}
          </Grid>
          <Skeleton height={12} width={220} radius="sm" />
          <Grid>
            {[0, 1, 2].map((i) => (
              <Grid.Col key={i} span={{ base: 12, md: 4 }}>
                <Paper withBorder radius="md" p={0} className="overflow-hidden">
                  <Skeleton height={44} radius={0} />
                  <Stack gap={0} p={0}>
                    {[0, 1].map((j) => (
                      <Group key={j} justify="space-between" wrap="nowrap" gap="sm" px="md" py="sm">
                        <Stack gap={6}>
                          <Skeleton height={14} width={60} radius="sm" />
                          <Skeleton height={10} width={70} radius="sm" />
                        </Stack>
                        <Skeleton height={28} width={70} radius="sm" />
                      </Group>
                    ))}
                  </Stack>
                </Paper>
              </Grid.Col>
            ))}
          </Grid>
        </Stack>
      </Card>

      {/* Recent referrals */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Skeleton height={20} width={160} radius="sm" />
          <Stack gap="xs">
            {[0, 1, 2].map((i) => (
              <Paper
                key={i}
                withBorder
                p="sm"
                radius="md"
                className="bg-gray-50 dark:bg-white/[0.03]"
              >
                <Group justify="space-between" wrap="nowrap" align="center">
                  <Group gap="sm" wrap="nowrap">
                    <Skeleton height={36} width={36} circle />
                    <Stack gap={4}>
                      <Skeleton height={14} width={140} radius="sm" />
                      <Group gap={6}>
                        <Skeleton height={16} width={60} radius="xl" />
                        <Skeleton height={10} width={90} radius="sm" />
                      </Group>
                    </Stack>
                  </Group>
                  <Skeleton height={24} width={90} radius="sm" />
                </Group>
              </Paper>
            ))}
          </Stack>
        </Stack>
      </Card>

      {/* Program terms footer */}
      <Skeleton height={12} width={100} radius="sm" className="mx-auto" />
    </Stack>
  );
}

function StatBlockSkeleton() {
  return (
    <Paper withBorder radius="md" p="md" className="bg-gray-50 dark:bg-white/[0.03]">
      <Group gap="md" wrap="nowrap">
        <Skeleton height={44} width={44} radius="md" />
        <Stack gap={6} className="flex-1">
          <Skeleton height={10} width={80} radius="sm" />
          <Group gap={4} wrap="nowrap">
            <Skeleton height={18} width={18} circle />
            <Skeleton height={22} width={80} radius="sm" />
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
}
