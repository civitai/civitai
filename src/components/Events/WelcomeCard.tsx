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
import styles from './WelcomeCard.module.scss';

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
    <Card className={styles.card} radius="lg">
      <Grid gutter={mobile ? 32 : 64}>
        <Grid.Col span={12}>
          <Text className={styles.title} weight="bold" lh={1.2}>
            &apos;Tis the season! Spread cheer across the platform by joining the Get Lit & Give
            Back challenge.
          </Text>
        </Grid.Col>
        <Grid.Col xs={12} sm="auto">
          <Stack spacing={32}>
            <Group spacing="lg" noWrap>
              <IconMoodPlus size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text size={20} weight={600}>
                Join the event to get your holiday garland and lights.
              </Text>
            </Group>
            <Group spacing="lg" noWrap>
              <IconBulb size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text size={20} weight={600}>
                Earn a lightbulb for each{' '}
                <Text component={Link} href="/challenges" td="underline">
                  holiday challenge
                </Text>{' '}
                you participate in.
              </Text>
            </Group>
            <Group spacing="lg" noWrap>
              <IconBolt size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text size={20} weight={600}>
                Make those lights shine by boosting your team&apos;s Spirit Bank with Buzz.
              </Text>
            </Group>
            <Group spacing="lg" noWrap>
              <IconHeartHandshake size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text size={20} weight={600}>
                All Buzz purchased and put into the Spirit Bank will be donated to All Hands and
                Hearts.
              </Text>
            </Group>
          </Stack>
        </Grid.Col>
        <Grid.Col xs={12} sm="auto">
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
              rightIcon={!equipping ? <IconChevronRight /> : undefined}
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

