import { Button, Card, Grid, Group, Stack, Text, createStyles } from '@mantine/core';
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

const useStyles = createStyles((theme) => ({
  card: {
    padding: '64px 80px !important',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    [theme.fn.smallerThan('sm')]: {
      padding: '32px 16px !important',
    },
  },
  title: {
    fontSize: 40,
    [theme.fn.smallerThan('sm')]: {
      fontSize: 28,
    },
  },
}));

export function WelcomeCard({ event, about }: { event: string; about: string }) {
  const { classes } = useStyles();
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
    <Card className={classes.card} radius="lg">
      <Grid gutter={mobile ? 32 : 64}>
        <Grid.Col span={12}>
          <Text className={classes.title} weight="bold" lh={1.2}>
            &apos;Tis the season! Spread cheer across the platform by joining the Get Lit & Give
            Back challenge.
          </Text>
        </Grid.Col>
        <Grid.Col xs={12} sm="auto">
          <Stack spacing={32}>
            <Group spacing="lg" noWrap>
              <IconMoodPlus size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text size={20} weight={600}>
                Join the contest to get your lights.
              </Text>
            </Group>
            <Group spacing="lg" noWrap>
              <IconBulb size={48} stroke={1.5} style={{ minWidth: 48 }} />
              <Text size={20} weight={600}>
                Earn a lightbulb for every day you post new content.
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
                All Buzz purchased and put into the Spirit Bank will be donated to the Juvenile
                Diabetes Research Foundation.
              </Text>
            </Group>
          </Stack>
        </Grid.Col>
        <Grid.Col xs={12} sm="auto">
          <Text lh={1.8}>{about}</Text>
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
