import { Anchor, Button, Card, Grid, Group, Stack, Text } from '@mantine/core';
import {
  IconBolt,
  IconBulb,
  IconChevronRight,
  IconHeartHandshake,
  IconMoodPlus,
} from '@tabler/icons-react';
import { useMutateEvent } from '~/components/Events/events.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { showErrorNotification } from '~/utils/notifications';
import { LoginRedirect } from '../LoginRedirect/LoginRedirect';
import { NextLink as Link, NextLink } from '~/components/NextLink/NextLink';

export function WelcomeCard({
  event,
  about,
  learnMore,
}: {
  event: string;
  about: string;
  learnMore?: string;
}) {
  const mobile = useIsMobile();

  const { activateCosmetic, equipping } = useMutateEvent();
  const handleEquipCosmetic = async () => {
    try {
      await activateCosmetic({ event });
    } catch (e) {
      const error = e as Error;
      showErrorNotification({ title: 'Unable to equip cosmetic', error });
    }
  };

  return (
    <Card className="bg-gray-0 px-32 py-16 md:px-64 md:py-80 dark:bg-dark-6" radius="lg">
      <Grid gutter={mobile ? 32 : 64}>
        <Grid.Col span={12}>
          <Text fw="bold" lh={1.2}>
            &apos;Tis the season! Spread cheer across the platform by joining the Get Lit & Give
            Back challenge.
          </Text>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 'auto' }}>
          <Stack gap={32}>
            <Group gap="lg" wrap="nowrap">
              <IconMoodPlus size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text fz={20} fw={600}>
                Join the event to get your holiday garland and lights.
              </Text>
            </Group>
            <Group gap="lg" wrap="nowrap">
              <IconBulb size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text fz={20} fw={600}>
                Earn a lightbulb for each{' '}
                <Text component={Link} href="/challenges" td="underline">
                  holiday challenge
                </Text>{' '}
                you participate in.
              </Text>
            </Group>
            <Group gap="lg" wrap="nowrap">
              <IconBolt size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text fz={20} fw={600}>
                Make those lights shine by boosting your team&apos;s Spirit Bank with Buzz.
              </Text>
            </Group>
            <Group gap="lg" wrap="nowrap">
              <IconHeartHandshake size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text fz={20} fw={600}>
                All Buzz purchased and put into the Spirit Bank will be donated to All Hands and
                Hearts.
              </Text>
            </Group>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 'auto' }}>
          <Text lh={1.8}>{about}</Text>
          {learnMore && (
            <Anchor component={NextLink} href={learnMore}>
              Learn more
            </Anchor>
          )}
        </Grid.Col>
        <Grid.Col span={12}>
          <LoginRedirect reason="perform-action">
            <Button
              radius="xl"
              size={mobile ? 'sm' : 'xl'}
              rightSection={!equipping ? <IconChevronRight /> : undefined}
              onClick={handleEquipCosmetic}
              loading={equipping}
              fullWidth
            >
              {equipping ? 'Assigning team...' : 'Join the challenge'}
            </Button>
          </LoginRedirect>
        </Grid.Col>
      </Grid>
    </Card>
  );
}
