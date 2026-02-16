import { Badge, Button, Card, Divider, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { strikeStatusColorScheme } from '~/server/schema/strike.schema';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function StrikesCard() {
  const { data: summary, isLoading } = trpc.strike.getMyStrikeSummary.useQuery();
  const [showDetails, { toggle }] = useDisclosure(false);

  if (isLoading) {
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

  return (
    <Card withBorder id="strikes">
      <Stack>
        <Group justify="space-between" align="center">
          <Title order={2}>Account Standing</Title>
          <Badge color={standingColor} size="lg" variant="filled">
            {standingLabel}
          </Badge>
        </Group>

        {points === 0 ? (
          <Text size="sm" c="dimmed">
            Your account is in good standing. You have no active strikes.
          </Text>
        ) : (
          <Stack gap="xs">
            <Text size="sm">
              You have <strong>{summary?.activeStrikes}</strong> active{' '}
              {summary?.activeStrikes === 1 ? 'strike' : 'strikes'} with a total of{' '}
              <strong>{points}</strong> {points === 1 ? 'point' : 'points'}.
            </Text>
            {summary?.nextExpiry && (
              <Text size="sm" c="dimmed">
                Next strike expires: {formatDate(summary.nextExpiry)}
              </Text>
            )}
            <Button variant="subtle" size="xs" onClick={toggle} w="fit-content">
              {showDetails ? 'Hide details' : 'View strike details'}
            </Button>
          </Stack>
        )}

        {showDetails && <StrikeDetails />}
      </Stack>
    </Card>
  );
}

function StrikeDetails() {
  const { data, isLoading } = trpc.strike.getMyStrikes.useQuery({ includeExpired: false });

  if (isLoading) return <Loader size="sm" />;

  const strikes = data?.strikes ?? [];
  if (strikes.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No active strikes found.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Divider />
      {strikes.map((strike) => (
        <Card key={strike.id} withBorder padding="sm" radius="sm">
          <Stack gap={4}>
            <Group justify="space-between">
              <Badge color={strikeStatusColorScheme[strike.status] ?? 'gray'} size="sm">
                {strike.status}
              </Badge>
              <Text size="xs" c="dimmed">
                {strike.points} {strike.points === 1 ? 'point' : 'points'}
              </Text>
            </Group>
            <Text size="sm" fw={500}>
              {getDisplayName(strike.reason)}
            </Text>
            <Text size="sm">{strike.description}</Text>
            <Group gap="xs">
              <Text size="xs" c="dimmed">
                Issued: {formatDate(strike.createdAt)}
              </Text>
              <Text size="xs" c="dimmed">
                Expires: {formatDate(strike.expiresAt)}
              </Text>
            </Group>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
