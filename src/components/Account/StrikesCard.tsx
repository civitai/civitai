import { Badge, Card, Divider, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { strikeStatusColorScheme } from '~/server/schema/strike.schema';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { UserScoreDisplay } from './UserScoreDisplay';

export function StrikesCard() {
  const currentUser = useCurrentUser();
  const scores = currentUser?.meta?.scores;
  const { data: summary, isLoading: summaryLoading } = trpc.strike.getMyStrikeSummary.useQuery();
  const { data: strikesData, isLoading: strikesLoading } = trpc.strike.getMyStrikes.useQuery({
    includeExpired: false,
  });

  if (summaryLoading) {
    return (
      <Card withBorder>
        <Stack>
          <Title order={2}>Account Standing</Title>
          <Loader size="sm" />
        </Stack>
      </Card>
    );
  }

  const points = summary?.totalActivePoints ?? 0;
  const standingColor = points === 0 ? 'green' : points === 1 ? 'yellow' : 'red';
  const standingLabel = points === 0 ? 'Good Standing' : points === 1 ? 'Warning' : 'Restricted';
  const strikes = strikesData?.strikes ?? [];

  return (
    <Card withBorder id="strikes">
      <Stack gap="lg">
        {/* Header */}
        <Group justify="space-between" align="center">
          <Title order={2}>Account Standing</Title>
          <Badge
            color={standingColor}
            size="lg"
            variant="light"
            leftSection={points === 0 ? <IconCheck size={14} /> : undefined}
          >
            {standingLabel}
          </Badge>
        </Group>

        <Divider />

        {/* User Score Section */}
        <UserScoreDisplay scores={scores} />

        <Divider />

        {/* Strikes Section */}
        <Group justify="space-between" align="center">
          <Text size="lg" fw={700}>
            Strikes
          </Text>
          {points > 0 && (
            <Badge color={standingColor} size="md" variant="light">
              {summary?.activeStrikes} active &middot; {points} {points === 1 ? 'point' : 'points'}
            </Badge>
          )}
        </Group>

        {strikesLoading ? (
          <Loader size="sm" />
        ) : strikes.length === 0 ? (
          <Text size="sm" c="dimmed">
            No active strikes. Your account is in good standing.
          </Text>
        ) : (
          <Stack gap="sm">
            {strikes.map((strike) => (
              <Paper key={strike.id} withBorder p="md" radius="md">
                <Stack gap="xs">
                  <Group gap="xs" wrap="nowrap">
                    <div
                      role="img"
                      aria-label={strike.status === 'Active' ? 'Active strike' : 'Inactive strike'}
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        backgroundColor:
                          strike.status === 'Active'
                            ? 'var(--mantine-color-red-filled)'
                            : 'var(--mantine-color-gray-filled)',
                        flexShrink: 0,
                      }}
                    />
                    <Text size="sm" fw={600} style={{ flex: 1 }}>
                      {getDisplayName(strike.reason)}
                    </Text>
                    <Badge
                      color={strikeStatusColorScheme[strike.status] ?? 'gray'}
                      size="sm"
                      variant="light"
                    >
                      {strike.points} {strike.points === 1 ? 'pt' : 'pts'}
                    </Badge>
                  </Group>

                  <Text size="sm" c="dimmed">
                    {strike.description}
                  </Text>

                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">
                      Issued: {formatDate(strike.createdAt)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Expires: {formatDate(strike.expiresAt)}
                    </Text>
                  </Group>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
