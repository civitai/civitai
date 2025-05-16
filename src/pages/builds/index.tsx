import {
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Container,
  Group,
  Image,
  Loader,
  MantineColor,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  HoverCard,
} from '@mantine/core';
import { IconAlertCircle, IconBrandSpeedtest, IconCircleCheck } from '@tabler/icons-react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useState } from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuildBudget, BuildFeatures } from '~/server/schema/build-guide.schema';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import classes from './index.module.scss';

const buildBudgets = Object.keys(BuildBudget) as BuildBudget[];
const processors = ['AMD', 'Intel'] as const;

type State = {
  selectedBudget: BuildBudget;
  selectedProcessor: (typeof processors)[number];
};

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.buildGuide.getAll.prefetch();
  },
});

export default function BuildPage() {
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
        <Stack gap="xl">
          <Stack gap={0}>
            <Title>Hardware We Love</Title>
            <Text size="sm" c="dimmed" mb="sm">
              Any purchases made using these links directly contributes to Civitai ❤️
            </Text>
            <Group justify="space-between" gap={8}>
              <Stack gap={8}>
                <Text size="lg" weight={500} c="dimmed">
                  Select your budget
                </Text>
                <Chip.Group
                  value={state.selectedBudget}
                  onChange={(value) =>
                    setState((curr) => ({ ...curr, selectedBudget: value as BuildBudget }))
                  }
                >
                  <Group gap={4}>
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
                        <span>{budget}</span>
                      </Chip>
                    ))}
                  </Group>
                </Chip.Group>
              </Stack>
              <Stack gap={8}>
                <Text size="lg" weight={500} c="dimmed">
                  Processor
                </Text>
                <Chip.Group
                  value={state.selectedProcessor}
                  onChange={(value) =>
                    setState((curr) => ({
                      ...curr,
                      selectedProcessor: value as (typeof processors)[number],
                    }))
                  }
                >
                  <Group gap={4}>
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
                        <span>{processor}</span>
                      </Chip>
                    ))}
                  </Group>
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
                  <Group gap={8} justify="space-between">
                    <HoverCard shadow="md" width={300} zIndex={100} withArrow>
                      <HoverCard.Target>
                        <Stack gap={8}>
                          <Group gap={8} wrap="nowrap">
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
                        <Text c="yellow" weight={500}>
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
                  <Group gap={4}>
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
                      className="bg-gray-0 dark:bg-dark-5"
                      withBorder
                    >
                      <Group gap="lg" align="start" wrap="nowrap">
                        {data?.user && <UserAvatar user={data.user} avatarSize={64} />}
                        <Stack gap={8}>
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
                      <Group gap={80} justify="space-between" w="100%" wrap="nowrap">
                        <Group className={classes.componentTitleWrapper} gap="lg" wrap="nowrap">
                          <Image
                            src={component.imageUrl}
                            alt={component.name}
                            width={72}
                            radius="sm"
                          />
                          <Stack gap={8} align="flex-start" style={{ flex: 1 }}>
                            <Badge color="orange" radius="sm" tt="capitalize">
                              {component.type}
                            </Badge>
                            <Text size="lg" weight={600} lineClamp={2} lh={1.2}>
                              {component.name}
                            </Text>
                          </Stack>
                        </Group>
                        <Group className={classes.hideMobile} gap={40} wrap="nowrap">
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
                  <Group justify="space-between" mt={5}>
                    <Text c="dimmed" size="xs">
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
    <Group className={className} gap={4} align="start" wrap="nowrap">
      <Text fz={size} weight={600} c={color} inline>
        ${intPart}
      </Text>
      <Text fz={decimalFontSize} weight={600} c={color ?? 'dimmed'} inline>
        {decimalPart}
      </Text>
    </Group>
  );
}
