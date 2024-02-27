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
  HoverCard,
} from '@mantine/core';
import { IconAlertCircle, IconBrandSpeedtest, IconCircleCheck } from '@tabler/icons-react';
import { IconCheck } from '@tabler/icons-react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useState } from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuildBudget, BuildFeatures } from '~/server/schema/build-guide.schema';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client.mjs';
import dayjs from 'dayjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const buildBudgets = Object.keys(BuildBudget) as BuildBudget[];
const processors = ['AMD', 'Intel'] as const;

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

  componentTitleWrapper: {
    [theme.fn.smallerThan('sm')]: {
      flexDirection: 'row-reverse',
      width: '100%',
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

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.buildGuide.getAll.prefetch();
  },
});

const aDayAgo = dayjs().subtract(1, 'day').toDate();
export default function BuildPage() {
  const { classes } = useStyles();
  const [state, setState] = useState<State>({ selectedBudget: 'Mid', selectedProcessor: 'AMD' });
  const { data: builds, isLoading } = trpc.buildGuide.getAll.useQuery();
  const buildName = `${state.selectedBudget}_${state.selectedProcessor}`.toLowerCase();
  const data = builds?.find((build) => build.name === buildName);
  const showPrices = true; // Always show prices now...

  return (
    <>
      <Meta
        title="Civitai Build Guides | Hardware We Love"
        description="Find the best hardware for your budget and needs to build your own AI Generation machine. We love these components and we think you will too."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/builds`, rel: 'canonical' }]}
      />
      <Container size={800}>
        <Stack spacing="xl">
          <Stack spacing={0}>
            <Title>Hardware We Love</Title>
            <Text size="sm" color="dimmed" mb="sm">
              Any purchases made using these links directly contributes to Civitai ❤️
            </Text>
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
                      classNames={{
                        label: classes.chipLabel,
                        iconWrapper: classes.chipIconWrapper,
                      }}
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
                      classNames={{
                        label: classes.chipLabel,
                        iconWrapper: classes.chipIconWrapper,
                      }}
                      value={processor}
                      variant="filled"
                    >
                      {processor}
                    </Chip>
                  ))}
                </Chip.Group>
              </Stack>
            </Group>
          </Stack>
          {isLoading && !data ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : data ? (
            <>
              <Paper className={classes.section} p="xl" radius="md" withBorder>
                <Stack>
                  <Group spacing={8} position="apart">
                    <HoverCard shadow="md" width={300} zIndex={100} withArrow>
                      <HoverCard.Target>
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
                      </HoverCard.Target>
                      <HoverCard.Dropdown>
                        <Text color="yellow" weight={500}>
                          About Generation Speed
                        </Text>
                        <Text size="sm">
                          {`This gauge is based on a very accurate measure we call "Waifu Per Minute"
                          (WPM). It's a measure of how many waifus can be generated in a minute. The
                          higher the number, the better.`}
                        </Text>
                      </HoverCard.Dropdown>
                    </HoverCard>
                    <PriceTag price={data?.totalPrice ?? 0} size={48} />
                  </Group>
                  <Group spacing={4}>
                    {Object.entries(BuildFeatures).map(([key, name]) => {
                      const hasFeature = data?.capabilities?.features.includes(key as any);

                      return (
                        <Badge
                          size="lg"
                          color={hasFeature ? 'success.5' : 'gray'}
                          variant="outline"
                          radius="xl"
                          pl={6}
                          key={key}
                          leftSection={
                            hasFeature ? (
                              <IconCircleCheck size={20} />
                            ) : (
                              <IconAlertCircle size={20} />
                            )
                          }
                        >
                          {name}
                        </Badge>
                      );
                    })}
                  </Group>
                  {data?.message && (
                    <Card
                      radius="sm"
                      px="lg"
                      py="sm"
                      sx={(theme) => ({
                        backgroundColor:
                          theme.colorScheme === 'dark'
                            ? theme.colors.dark[5]
                            : theme.colors.gray[0],
                      })}
                      withBorder
                    >
                      <Group spacing="lg" align="start" noWrap>
                        {data?.user && <UserAvatar user={data.user} avatarSize={64} />}
                        <Stack spacing={8}>
                          <Text size="lg" weight="bold">
                            {data?.user.username}
                          </Text>
                          <ContentClamp maxHeight={60}>
                            <Text size="sm" lh="20px">
                              {data.message}
                            </Text>
                          </ContentClamp>
                        </Stack>
                      </Group>
                    </Card>
                  )}
                </Stack>
              </Paper>
              <Card className={classes.section} radius="md" pb={5} withBorder>
                {data?.components.map((component) => (
                  <Card.Section key={component.productId} withBorder p="xl">
                    <Stack className={classes.component}>
                      <Group spacing={80} position="apart" w="100%" noWrap>
                        <Group className={classes.componentTitleWrapper} spacing="lg" noWrap>
                          <Image
                            src={component.imageUrl}
                            alt={component.name}
                            width={72}
                            radius="sm"
                          />
                          <Stack spacing={8} align="flex-start" style={{ flex: 1 }}>
                            <Badge color="orange" radius="sm" tt="capitalize">
                              {component.type}
                            </Badge>
                            <Text size="lg" weight={600} lineClamp={2} lh={1.2}>
                              {component.name}
                            </Text>
                          </Stack>
                        </Group>
                        <Group className={classes.hideMobile} spacing={40} noWrap>
                          {showPrices && <PriceTag price={component.price} size={24} />}
                          <Button
                            component="a"
                            href={component.link}
                            rel="nofollow noreferrer"
                            target="_blank"
                            tt="uppercase"
                            rightIcon={<IconArrowUpRight size={16} />}
                          >
                            {showPrices && component.price ? 'Buy' : 'Check Price'}
                          </Button>
                        </Group>
                      </Group>

                      {showPrices && (
                        <PriceTag
                          className={classes.hideDesktop}
                          price={component.price}
                          size={32}
                        />
                      )}
                      <Button
                        component="a"
                        className={classes.hideDesktop}
                        href={component.link}
                        rel="nofollow noreferrer"
                        target="_blank"
                        tt="uppercase"
                        rightIcon={<IconArrowUpRight size={16} />}
                      >
                        {component.price ? 'Buy' : 'Check Price'}
                      </Button>
                    </Stack>
                  </Card.Section>
                ))}
                {data && data.updatedAt && (
                  <Group position="apart" mt={5}>
                    <Text color="dimmed" size="xs">
                      Prices last updated <DaysFromNow date={data.updatedAt} />
                    </Text>
                  </Group>
                )}
              </Card>
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
  price?: number;
  size: number;
  className?: string;
  color?: MantineColor;
}) {
  if (!price) return null;
  const [intPart, decimalPart] = price.toFixed(2).split('.');
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
