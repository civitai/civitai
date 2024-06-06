import { Alert, Center, Loader, SimpleGrid, Text, createStyles } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { SectionCard } from '~/components/Events/SectionCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useQueryEvent } from './events.utils';

const useStyles = createStyles((theme) => ({
  badge: {
    width: 96,
    height: 96,
    margin: `0 auto ${theme.spacing.md}px`,
  },
}));

export function EventRewards({ event }: { event: string }) {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();

  const { eventData, rewards, loadingRewards } = useQueryEvent({ event });
  const ended = eventData && eventData.endDate < new Date();

  const { data: cosmetics, isInitialLoading: loadingCosmetics } = trpc.user.getCosmetics.useQuery(
    undefined,
    {
      enabled: !!currentUser && !!ended,
    }
  );

  const earnedRewards = rewards.filter((reward) => {
    const cosmetic = cosmetics?.badges.find((cosmetic) => cosmetic.id === reward.id);
    return !!cosmetic;
  });

  const shownRewards = ended && currentUser ? earnedRewards : rewards;

  return (
    <SectionCard
      title="Event Rewards"
      subtitle={
        ended && currentUser
          ? 'These are the rewards you earned while the event was ongoing.'
          : 'Earn special badges for completing a variety of challenges during the event.'
      }
    >
      {loadingRewards || loadingCosmetics ? (
        <Center py="xl">
          <Loader variant="bars" />
        </Center>
      ) : shownRewards.length === 0 ? (
        <Alert color="red" radius="xl" ta="center" w="100%" py={8}>
          No rewards available
        </Alert>
      ) : (
        <SimpleGrid
          spacing={40}
          cols={2}
          breakpoints={[
            { minWidth: 'sm', cols: 3 },
            { minWidth: 'md', cols: 5 },
          ]}
        >
          {shownRewards.map((reward) => (
            <div key={reward.id}>
              <div className={classes.badge}>
                <EdgeMedia
                  src={(reward.data as { url: string })?.url}
                  alt={`Event reward: ${reward.name}`}
                />
              </div>
              <Text align="center" size="lg" weight={590} w="100%" tt="capitalize">
                {reward.name}
              </Text>
              <Text size="xs" color="dimmed" align="center">
                {reward.description}
              </Text>
            </div>
          ))}
        </SimpleGrid>
      )}
    </SectionCard>
  );
}
