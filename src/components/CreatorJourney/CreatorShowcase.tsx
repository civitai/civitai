import { Card, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { legendStatusLabel } from '~/components/CreatorJourney/legend-status';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export function CreatorShowcase() {
  const { data, isLoading } = trpc.creatorJourney.getShowcase.useQuery();

  if (isLoading) return <Loader className="mx-auto" />;
  if (!data)
    return <Text c="dimmed">The showcase couldn&apos;t load. Try again in a few minutes.</Text>;

  return (
    <Stack gap="xl">
      <Stack gap="sm">
        <Title order={2}>New Supernovas this month</Title>
        <Text c="dimmed">Creators who reached a Creator Score of 1,000,000 this month.</Text>
        {data.newSupernovas.length ? (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
            {data.newSupernovas.map(({ user, achievedAt }) => (
              <Card key={user.id} withBorder>
                <UserAvatar
                  user={user}
                  withUsername
                  linkToProfile
                  subText={`Reached ${formatDate(achievedAt, 'MMM D', true)}`}
                />
              </Card>
            ))}
          </SimpleGrid>
        ) : (
          <Text>No new Supernovas yet this month.</Text>
        )}
      </Stack>

      <Stack gap="sm">
        <Title order={2}>Hall of Fame</Title>
        <Text c="dimmed">Every creator who has reached Legend, a Creator Score of 10,000,000.</Text>
        {data.legends.length ? (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
            {data.legends.map(({ user, founding, since }) => (
              <Card key={user.id} withBorder>
                <UserAvatar
                  user={user}
                  withUsername
                  linkToProfile
                  subText={legendStatusLabel({ founding, since })}
                />
              </Card>
            ))}
          </SimpleGrid>
        ) : (
          <Text>No Legends yet.</Text>
        )}
      </Stack>
    </Stack>
  );
}
