import {
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Container,
  Divider,
  Group,
  Image,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
  createStyles,
} from '@mantine/core';
import { IconBrandSpeedtest } from '@tabler/icons-react';
import { IconCheck } from '@tabler/icons-react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { IconBomb } from '@tabler/icons-react';
import { useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuildBudget, GetBuildGuideByBudgetSchema } from '~/server/schema/build-guide.schema';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const buildBudgets = Object.keys(BuildBudget) as BuildBudget[];
const processors = ['AMD', 'Intel'] as const;

const useQueryBuildGuide = (filters: GetBuildGuideByBudgetSchema) => {
  const { data, isLoading } = trpc.buildGuide.getByBudget.useQuery(filters);

  return { data, isLoading };
};

type State = {
  selectedBudget: BuildBudget;
  selectedProcessor: (typeof processors)[number] | undefined;
};

const useStyles = createStyles((theme) => ({
  section: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : undefined,
  },

  component: {
    '&:not(:first-of-type)': {
      paddingTop: theme.spacing.sm,
      borderTop: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
      }`,
    },
  },

  // Chip styles
  chipLabel: {
    '&[data-variant="filled"]': {
      '&[data-checked]': {
        '&, &:hover': {
          color: theme.colors.blue[4],
          backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.2),
          padding: `0 ${theme.spacing.lg}px`,
        },
      },
    },
  },

  chipIconWrapper: { display: 'none' },
}));

export default function BuildPage() {
  const { classes } = useStyles();
  const [state, setState] = useState<State>({ selectedBudget: 'Low', selectedProcessor: 'AMD' });
  const { data, isLoading } = useQueryBuildGuide({ budget: 'Low' });

  return (
    <Container py="xl">
      <Stack spacing="xl">
        <Title>Hardware we love</Title>
        <Group position="apart" spacing={8}>
          <Stack spacing={8}>
            <Text size="lg" weight={500} color="dimmed">
              Select your budget
            </Text>
            <Chip.Group
              spacing={4}
              value={state.selectedBudget}
              onChange={(value) =>
                setState((curr) => ({ ...curr, selectedBudget: value as BuildBudget }))
              }
            >
              {buildBudgets.map((budget) => (
                <Chip
                  key={budget}
                  classNames={{ label: classes.chipLabel, iconWrapper: classes.chipIconWrapper }}
                  value={budget}
                  variant="filled"
                >
                  {budget}
                </Chip>
              ))}
            </Chip.Group>
          </Stack>
          <Stack spacing={8}>
            <Text size="lg" weight={500} color="dimmed">
              Processor
            </Text>
            <Chip.Group
              spacing={4}
              value={state.selectedProcessor}
              onChange={(value) =>
                setState((curr) => ({
                  ...curr,
                  selectedProcessor: value as (typeof processors)[number],
                }))
              }
            >
              {processors.map((processor) => (
                <Chip
                  key={processor}
                  classNames={{ label: classes.chipLabel, iconWrapper: classes.chipIconWrapper }}
                  value={processor}
                  variant="filled"
                >
                  {processor}
                </Chip>
              ))}
            </Chip.Group>
          </Stack>
        </Group>
        {isLoading && !data ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : (
          <>
            <Paper className={classes.section} p="xl" radius="md" withBorder>
              <Stack>
                <Group spacing={8} position="apart">
                  <Stack spacing={8}>
                    <Group spacing={8} noWrap>
                      <Text size="xl" weight={600}>
                        Generation Speed
                      </Text>
                      <IconBrandSpeedtest size={32} />
                    </Group>
                    <Progress
                      color="success.5"
                      radius="xl"
                      value={(data?.capabilities?.speed ?? 0) * 10}
                    />
                  </Stack>
                  <Group spacing={4} align="start">
                    <Text size={48} weight={600} inline>
                      ${numberWithCommas(data?.totalPrice ?? 0)}
                    </Text>
                    <Text size="xl" color="dimmed" weight={600} span>
                      86
                    </Text>
                  </Group>
                </Group>
                <Group spacing={4}>
                  {data?.capabilities?.features.map((feature) => (
                    <Badge
                      size="lg"
                      color="success.5"
                      variant="outline"
                      radius="xl"
                      pl={6}
                      key={feature.id}
                      leftSection={<IconCheck />}
                    >
                      {feature.name}
                    </Badge>
                  ))}
                </Group>
                <Card
                  radius="sm"
                  px="lg"
                  py="sm"
                  sx={(theme) => ({
                    backgroundColor:
                      theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
                  })}
                  withBorder
                >
                  <Group spacing="lg" align="start" noWrap>
                    {data?.user && <UserAvatar user={data.user} avatarSize={64} />}
                    <Stack spacing={8}>
                      <Text size="lg" weight="bold">
                        {data?.user.username}
                      </Text>
                      {data?.message && <Text size="sm">{data?.message}</Text>}
                    </Stack>
                  </Group>
                </Card>
              </Stack>
            </Paper>
            <Paper className={classes.section} p="xl" radius="md" withBorder>
              <Stack>
                {data?.components.map((component) => (
                  <Group
                    key={component.productId}
                    className={classes.component}
                    spacing={80}
                    position="apart"
                    w="100%"
                    noWrap
                  >
                    <Group spacing="lg" noWrap>
                      <Image src={component.imageUrl} alt={component.name} width={72} radius="sm" />
                      <Stack spacing={8} align="flex-start">
                        <Badge color="orange" radius="md">
                          {component.type}
                        </Badge>
                        <Text size="lg" weight={600} lineClamp={2}>
                          {component.name}
                        </Text>
                      </Stack>
                    </Group>
                    <Group noWrap>
                      <Text size="xl" weight={600}>
                        ${numberWithCommas(component.price)}
                      </Text>
                      <Button
                        component="a"
                        href={component.link}
                        rel="nofollow noreferrer"
                        target="_blank"
                        tt="uppercase"
                        rightIcon={<IconArrowUpRight size={16} />}
                      >
                        Buy
                      </Button>
                    </Group>
                  </Group>
                ))}
                {data && data.updatedAt && (
                  <Stack spacing="xs">
                    <Divider />
                    <Text color="dimmed">
                      Prices last updated <DaysFromNow date={data.updatedAt} />
                    </Text>
                  </Stack>
                )}
              </Stack>
            </Paper>
          </>
        )}
      </Stack>
    </Container>
  );
}
