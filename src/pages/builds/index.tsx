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
  MantineColor,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  createStyles,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBrandSpeedtest } from '@tabler/icons-react';
import { IconCheck } from '@tabler/icons-react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useState } from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuildBudget, GetBuildGuideByBudgetSchema } from '~/server/schema/build-guide.schema';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client.mjs';

const buildBudgets = Object.keys(BuildBudget) as BuildBudget[];
const processors = ['AMD', 'Intel'] as const;

const useQueryBuildGuide = (filters: GetBuildGuideByBudgetSchema) => {
  const { data, isLoading } = trpc.buildGuide.getByBudget.useQuery(filters, {
    cacheTime: Infinity,
    staleTime: Infinity,
  });

  return { data, isLoading };
};

type State = {
  selectedBudget: BuildBudget;
  selectedProcessor: (typeof processors)[number];
};

const useStyles = createStyles((theme) => ({
  section: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : undefined,

    [theme.fn.smallerThan('sm')]: {
      padding: theme.spacing.md,
    },
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

  hideMobile: {
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },
  hideDesktop: {
    [theme.fn.largerThan('sm')]: {
      display: 'none',
    },
  },
}));

export default function BuildPage() {
  const { classes } = useStyles();
  const [state, setState] = useState<State>({ selectedBudget: 'Low', selectedProcessor: 'AMD' });
  const { data, isLoading } = useQueryBuildGuide({
    budget: state.selectedBudget,
    processor: state.selectedProcessor,
  });

  return (
    <>
      <Meta
        title="Civitai Build Guides | Hardware We Love"
        description="Find the best hardware for your budget and needs to build your own AI Generation machine. We love these components and we think you will too."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/builds`, rel: 'canonical' }]}
      />
      <Container size={800} py="xl">
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
          ) : data ? (
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
                    <PriceTag price={data?.totalPrice ?? 0} size={48} />
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
                        {data?.message && (
                          // Three lines of text
                          <ContentClamp maxHeight={60}>
                            <Text size="sm" lh="20px">
                              {data.message}
                            </Text>
                          </ContentClamp>
                        )}
                      </Stack>
                    </Group>
                  </Card>
                </Stack>
              </Paper>
              <Paper className={classes.section} p="xl" radius="md" withBorder>
                <Stack>
                  {data?.components.map((component) => (
                    <Stack key={component.productId} className={classes.component}>
                      <Group spacing={80} position="apart" w="100%" noWrap>
                        <Group spacing="lg" noWrap>
                          <Image
                            src={component.imageUrl}
                            alt={component.name}
                            width={72}
                            radius="sm"
                          />
                          <Stack spacing={8} align="flex-start">
                            <Badge color="orange" radius="md">
                              {component.type}
                            </Badge>
                            <Text size="lg" weight={600} lineClamp={2}>
                              {component.name}
                            </Text>
                          </Stack>
                        </Group>
                        <Group className={classes.hideMobile} spacing={40} noWrap>
                          <PriceTag price={component.price} size={24} />
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

                      <Button
                        component="a"
                        className={classes.hideDesktop}
                        href={component.link}
                        rel="nofollow noreferrer"
                        target="_blank"
                        rightIcon={<IconArrowUpRight size={16} />}
                      >
                        <Group spacing={4} noWrap>
                          Buy for <PriceTag price={component.price} size={16} color="white" />
                        </Group>
                      </Button>
                    </Stack>
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
          ) : (
            <NoContent message="We couldn't match what you're looking for. Please try again later." />
          )}
        </Stack>
      </Container>
    </>
  );
}

const PRICE_FONT_SIZE_COEFFICIENT = 1.71;
function PriceTag({
  price,
  size,
  className,
  color,
}: {
  price: number;
  size: number;
  className?: string;
  color?: MantineColor;
}) {
  const priceString = formatPriceForDisplay(price, Currency.USD);
  const [intPart, decimalPart] = priceString.split('.');
  const decimalFontSize = size / PRICE_FONT_SIZE_COEFFICIENT;

  return (
    <Group className={className} spacing={4} align="start" noWrap>
      <Text size={size} weight={600} color={color} inline>
        ${intPart}
      </Text>
      <Text size={decimalFontSize} weight={600} color={color ?? 'dimmed'} inline>
        {decimalPart}
      </Text>
    </Group>
  );
}
