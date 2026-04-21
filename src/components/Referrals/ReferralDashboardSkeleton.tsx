import { Card, Grid, Group, Paper, Skeleton, Stack } from '@mantine/core';

export function ReferralDashboardSkeleton() {
  return (
    <Stack gap="lg">
      {/* Title + subtitle */}
      <Stack gap={6}>
        <Skeleton height={28} width={140} radius="sm" />
        <Skeleton height={16} width="80%" radius="sm" />
      </Stack>

      {/* Code block */}
      <Paper withBorder radius="md" p="lg">
        <Stack gap="lg">
          <Stack gap={8}>
            <Skeleton height={12} width={120} radius="sm" />
            <Group gap={8}>
              <Skeleton height={48} width={220} radius="md" />
              <Skeleton height={36} circle />
            </Group>
          </Stack>
          <Skeleton height={1} radius={0} />
          <Stack gap={8}>
            <Skeleton height={12} width={80} radius="sm" />
            <Group gap="xs">
              <Skeleton height={28} width={100} radius="md" />
              <Skeleton height={28} width={110} radius="md" />
              <Skeleton height={28} width={130} radius="md" />
              <Skeleton height={28} width={130} radius="md" />
            </Group>
          </Stack>
        </Stack>
      </Paper>

      {/* How it works */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Skeleton height={20} width={140} radius="sm" />
          <Grid>
            {[0, 1, 2, 3].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 6, md: 3 }}>
                <Paper withBorder radius="md" p={0} className="overflow-hidden">
                  <Skeleton height={112} radius={0} />
                  <Stack gap={6} p="md" align="center">
                    <Skeleton height={14} width={80} radius="sm" />
                    <Skeleton height={12} width="90%" radius="sm" />
                    <Skeleton height={12} width="70%" radius="sm" />
                  </Stack>
                </Paper>
              </Grid.Col>
            ))}
          </Grid>
        </Stack>
      </Card>

      {/* Rank card */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Group gap="md" wrap="nowrap">
            <Skeleton height={64} width={64} radius="md" />
            <Stack gap={6} className="flex-1">
              <Skeleton height={12} width={80} radius="sm" />
              <Skeleton height={32} width={180} radius="sm" />
              <Skeleton height={12} width={240} radius="sm" />
            </Stack>
          </Group>
          <Stack gap={8}>
            <Group justify="space-between">
              <Skeleton height={12} width={100} radius="sm" />
              <Skeleton height={12} width={80} radius="sm" />
            </Group>
            <Skeleton height={16} radius="xl" />
          </Stack>
          <Grid>
            {[0, 1, 2].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 4 }}>
                <StatBlockSkeleton />
              </Grid.Col>
            ))}
          </Grid>
        </Stack>
      </Card>

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
          <Stack gap="xs">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={60} radius="md" />
            ))}
          </Stack>
        </Stack>
      </Card>

      {/* Token Bank */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Stack gap={6}>
            <Skeleton height={20} width={180} radius="sm" />
            <Skeleton height={14} width="60%" radius="sm" />
          </Stack>
          <Grid>
            {[0, 1].map((i) => (
              <Grid.Col key={i} span={{ base: 12, sm: 6 }}>
                <StatBlockSkeleton />
              </Grid.Col>
            ))}
          </Grid>
          <Grid>
            {[0, 1, 2].map((i) => (
              <Grid.Col key={i} span={{ base: 12, md: 4 }}>
                <Skeleton height={180} radius="md" />
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
              <Skeleton key={i} height={64} radius="md" />
            ))}
          </Stack>
        </Stack>
      </Card>
    </Stack>
  );
}

function StatBlockSkeleton() {
  return (
    <Paper withBorder radius="md" p="md">
      <Group gap="md" wrap="nowrap">
        <Skeleton height={44} width={44} radius="md" />
        <Stack gap={6} className="flex-1">
          <Skeleton height={10} width={80} radius="sm" />
          <Skeleton height={22} width={100} radius="sm" />
        </Stack>
      </Group>
    </Paper>
  );
}
