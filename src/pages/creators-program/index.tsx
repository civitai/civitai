import {
  Container,
  createStyles,
  Stack,
  Group,
  Text,
  Title,
  Paper,
  Grid,
  Alert,
  Accordion,
  Anchor,
  Divider,
  Button,
} from '@mantine/core';
import {
  IconAsterisk,
  IconBolt,
  IconBrandStripe,
  IconCaretRightFilled,
  IconCash,
  IconCloudDownload,
  IconGift,
  IconHeartHandshake,
  IconMessage,
  IconMoneybag,
  IconMoodSmile,
  IconRating18Plus,
  IconUserCheck,
  IconUsers,
  IconWand,
  IconWindmill,
  IconWorldCheck,
} from '@tabler/icons-react';
import { formatCurrencyForDisplay, numberWithCommas } from '../../utils/number-helpers';
import { constants } from '../../server/common/constants';
import { Currency } from '@prisma/client';
import { CurrencyIcon } from '../../components/Currency/CurrencyIcon';
import { Meta } from '../../components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const sizing = {
  header: {
    title: 52,
    subtitle: 28,
  },
  sections: {
    title: 32,
    subtitle: 'xl',
  },
  exclusivePerks: {
    icons: 52,
    text: 'xl',
  },
  earnBuzz: {
    value: 52,
    text: 'xl',
  },
} as const;

export default function CreatorsClubIntro() {
  const { cx, classes, theme } = useStyles();
  const currentUser = useCurrentUser();
  const applyFormUrl = `https://forms.clickup.com/8459928/f/825mr-10271/6KI6AW90JTXU6TYX4L?Username=${currentUser?.username}`;
  return (
    <>
      <Meta title="Creators Program | Civitai" />
      <Container>
        <Stack spacing="lg">
          <Title size={sizing.header.title} className={classes.highlightColor} lh={1} mb="sm">
            <Text component="span" size={32} weight={700}>
              Introducing the
            </Text>
            <br />
            Civitai Creators Program
          </Title>

          <Text size={sizing.header.subtitle} lh={1.3} mb="xs">
            One of the core tenets of Civitai is that creators should be able to monetize their
            work. The Civitai Creators Program is the pathway for creators on Civitai to getting
            paid for their contributions
          </Text>
          <Group>
            <Button
              size="lg"
              color="gray"
              mb={48}
              rightIcon={<IconCaretRightFilled />}
              component="a"
              href={applyFormUrl}
              target="_blank"
            >
              Apply now
            </Button>
          </Group>
          <Grid>
            <Grid.Col span={12}>
              <Paper
                withBorder
                className={cx(classes.card, classes.highlightCard, classes.earnBuzzCard)}
                h="100%"
              >
                <Group position="apart" noWrap>
                  <Title order={3} color="yellow.8">
                    New ways to earn buzz
                  </Title>
                  <Group spacing={0} noWrap>
                    <IconBolt style={{ fill: theme.colors.yellow[7] }} size={40} color="yellow.7" />
                    <IconBolt
                      style={{ fill: theme.colors.yellow[7], margin: '0 -20' }}
                      size={64}
                      color="yellow.7"
                    />
                    <IconBolt style={{ fill: theme.colors.yellow[7] }} size={40} color="yellow.7" />
                  </Group>
                </Group>
              </Paper>
            </Grid.Col>
            <Grid.Col xs={6} sm={4}>
              <Paper
                withBorder
                className={cx(classes.card, classes.highlightCard, classes.getPaidCard)}
                h="100%"
              >
                <IconGift size={40} className={classes.highlightCardBackgroundIcon} />
                <Stack pos="relative">
                  <Title order={3} color="green.8">
                    Get paid for your buzz
                  </Title>
                  <Group spacing={0} noWrap>
                    <IconBolt
                      style={{ fill: theme.colors.yellow[7] }}
                      size={40}
                      color={theme.colors.yellow[9]}
                      stroke={1}
                    />
                    <IconMoneybag
                      size={40}
                      color={theme.colors.yellow[9]}
                      style={{ fill: theme.colors.yellow[7] }}
                      stroke={1}
                    />
                  </Group>
                </Stack>
              </Paper>
            </Grid.Col>
            <Grid.Col xs={12} sm={8}>
              <Paper
                withBorder
                className={cx(classes.card, classes.highlightCard, classes.newPerksCard)}
                h="100%"
              >
                <Stack pos="relative">
                  <Title order={3} color="blue.8">
                    All new perks
                  </Title>
                  <Group position="center" spacing="xl" noWrap>
                    <IconWand color={theme.colors.blue[8]} size={62} />
                    <IconHeartHandshake color={theme.colors.blue[8]} size={62} />
                    <IconCash color={theme.colors.blue[8]} size={62} />
                  </Group>
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
          <ExclusivePerksSection />
          <EarnBuzzSection />
          <JoinSection applyFormUrl={applyFormUrl} />
          <FAQ />
        </Stack>
      </Container>
    </>
  );
}

const exclusivePerks: { text: string; icon: React.ReactNode }[] = [
  {
    text: 'Early access to test new creator tools',
    icon: <IconWand size={sizing.exclusivePerks.icons} />,
  },
  {
    text: 'A direct communication channel to the Civitai Team',
    icon: <IconHeartHandshake size={sizing.exclusivePerks.icons} />,
  },
  {
    text: 'Civitai will pay you for your Buzz',
    icon: <IconCash size={sizing.exclusivePerks.icons} />,
  },
];

const ExclusivePerksSection = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          Exclusive perks
        </Title>
        <Text size={sizing.sections.subtitle}>
          Members of the Creator Program enjoy a number of exclusive perks
        </Text>
      </Stack>
      <Grid>
        {exclusivePerks.map(({ text, icon }, index) => (
          <Grid.Col span={12} sm={4} key={index}>
            <Paper withBorder className={cx(classes.card)} h="100%">
              {icon}
              <Text className={classes.highlightColor} size={sizing.exclusivePerks.text}>
                {text}
              </Text>
            </Paper>
          </Grid.Col>
        ))}

        <Grid.Col span={12}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            <Group grow>
              <Stack spacing="xs" maw="unset">
                <Title order={3} className={classes.highlightColor}>
                  How you&rsquo;re paid
                </Title>
                <Text>
                  Civitai will pay Creators within the program{' '}
                  <Text component="span" className={classes.highlightColor}>
                    ${formatCurrencyForDisplay(100)} USD for every{' '}
                    <CurrencyIcon
                      currency={Currency.BUZZ}
                      stroke={0}
                      style={{ display: 'inline' }}
                    />
                    {numberWithCommas(constants.buzz.buzzDollarRatio)}
                  </Text>
                </Text>
                <Text>
                  At the time of payment Civitai will{' '}
                  <Text component="span" className={classes.highlightColor} underline>
                    take a {constants.buzz.platformFeeRate / 100}% platform fee.
                  </Text>
                </Text>
              </Stack>
              <Stack spacing="xs" maw="unset">
                <Group spacing={0}>
                  <CurrencyIcon size={42} currency={Currency.BUZZ} stroke={0} />
                  <Text size={32} weight="bold" className={classes.highlightColor}>
                    {numberWithCommas(constants.buzz.buzzDollarRatio)}
                  </Text>
                </Group>
                <Group spacing={0}>
                  <CurrencyIcon size={42} currency={Currency.USD} />
                  <Text size={32} weight="bold" className={classes.highlightColor}>
                    {formatCurrencyForDisplay(100)}
                  </Text>
                </Group>
              </Stack>
            </Group>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

const waysToEarnBuzz: { text: string; value: number }[] = [
  {
    value: constants.creatorsProgram.rewards.earlyAccessUniqueDownload,
    text: 'For every unique user that downloads your early access resource',
  },
  {
    value: 1000 * constants.creatorsProgram.rewards.generatedImageWithResource,
    text: 'For every 1,000 images generated on-site using one of your resources',
  },
];

const EarnBuzzSection = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0} mb="sm">
        <Title order={2} size={sizing.sections.title} className={classes.highlightColor}>
          New ways to earn Buzz
        </Title>
        <Text size={sizing.sections.subtitle}>
          As a valued member of the Creators Program, you get 3 new ways to earn buzz{' '}
        </Text>
      </Stack>
      <Grid>
        {waysToEarnBuzz.map(({ text, value }, index) => (
          <Grid.Col xs={6} key={index}>
            <Paper withBorder className={cx(classes.card)} h="100%">
              <Group spacing={0}>
                <CurrencyIcon currency={Currency.BUZZ} stroke={0} size={sizing.earnBuzz.value} />{' '}
                <Text className={classes.highlightColor} size={sizing.earnBuzz.value} weight="bold">
                  {value}
                </Text>
              </Group>
              <Text className={classes.highlightColor} size={sizing.earnBuzz.text}>
                {text}
              </Text>
            </Paper>
          </Grid.Col>
        ))}
      </Grid>
      <Alert color="yellow.7">
        <strong>NOTE:</strong> The Creator program is just getting started, so Buzz rewards will be
        tweaked over time as we dial in the right balance. This process will be transparent to all
        Creator Program members, our goal is to ensure you&rsquo;re able to monetize in a
        sustainable way.
      </Alert>
      <Text className={classes.highlightColor} size="xs">
        <IconAsterisk className={classes.highlightColor} size={12} style={{ display: 'inline' }} />{' '}
        Resources may only be in early access for a maximum of 14 days and then must be made
        available to all users
      </Text>
    </Stack>
  );
};

const JoinSection = ({ applyFormUrl }: { applyFormUrl: string }) => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0} mb="sm">
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          How do I join?
        </Title>
      </Stack>
      <Grid>
        <Grid.Col xs={12} sm={6}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            <Stack spacing="sm" h="100%">
              <Text mb="lg" className={classes.highlightColor} size="lg">
                Creators interested in joining the program must meet the following requirements:
              </Text>
              <Group noWrap w="100%">
                <IconWorldCheck size={24} />
                <Text>
                  Reside within a{' '}
                  <Anchor
                    href="https://stripe.com/docs/connect/cross-border-payouts#supported-countries"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    supported country
                  </Anchor>
                </Text>
              </Group>
              <Divider />
              <Group noWrap w="100%">
                <IconUserCheck size={24} />
                <Text>Account is in good standing</Text>
              </Group>
              <Divider />
              <Group noWrap w="100%" mb="xl">
                <IconRating18Plus size={24} />
                <Text>Be 18 or older</Text>
              </Group>

              <Button
                size="lg"
                mt="auto"
                rightIcon={<IconCaretRightFilled />}
                component="a"
                href={applyFormUrl}
                target="_blank"
              >
                Apply now
              </Button>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col xs={12} sm={6}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            <Stack spacing="sm">
              <Text mb="sm" className={classes.highlightColor} size="lg">
                <strong>For this batch we are accepting 50 creators</strong>. To apply you must meet
                the following requirements:
              </Text>
              <Group noWrap w="100%">
                <IconUsers size={24} />
                <Text>1,000 Followers</Text>
              </Group>
              <Divider />
              <Text mt="lg" className={classes.highlightColor} size="lg">
                Applications will be prioritized by:
              </Text>
              <Group noWrap w="100%">
                <IconCloudDownload size={24} />
                <Text>Unique Downloads</Text>
              </Group>
              <Divider />
              <Group noWrap w="100%">
                <IconWindmill size={24} />
                <Text>Unique Generations</Text>
              </Group>
              <Divider />
              <Group noWrap w="100%">
                <IconMoodSmile size={24} />
                <Text>Unique Reaction To Your Content</Text>
              </Group>
              <Divider />
              <Group noWrap w="100%">
                <IconMessage size={24} />
                <Text>Unique Engagement (comments/reviews)</Text>
              </Group>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

const faq: { q: string; a: string | React.ReactNode }[] = [
  {
    q: 'Why a 30% platform fee on payments?',
    a: 'While some of that fee goes to covering payment processing and currency conversion, most of it goes towards offsetting the cost of the Buzz we give out to users for the rewards system. That’s the Buzz you get for reacting to content, posting images, receiving reactions and more. Its important to keep this Buzz in circulation, since it encourages users to engage with your resources and content. Since introducing the Buzz reward system we’ve seen a 60% increase in the number of people that react to content each day.',
  },
  {
    q: 'I make NSFW/Celebrity/Anime/Furry resources and content, can I still join?',
    a: 'Yes, you’re not restricted from the program based on your content.',
  },
  {
    q: 'How and when will I get paid?',
    a: (
      <Text>
        You can get paid for a minimum of{' '}
        <CurrencyIcon
          currency={Currency.BUZZ}
          stroke={0}
          style={{ position: 'relative', top: 5 }}
        />
        {numberWithCommas(constants.buzz.minBuzzWithdrawal)} and maximum of{' '}
        <CurrencyIcon
          currency={Currency.BUZZ}
          stroke={0}
          style={{ position: 'relative', top: 5 }}
        />
        {numberWithCommas(constants.buzz.maxBuzzWithdrawal)} each day. Direct $ Tips and donations
        do not count toward these limits.
      </Text>
    ),
  },
  {
    q: 'Can I get paid in currencies other than USD?',
    a: 'Yes, you can get paid in your native currency.',
  },
  {
    q: 'Can I leave the Creator Program?',
    a: 'Anytime you want. Its a voluntary program.',
  },
  {
    q: 'How will changes to the program be communicated?',
    a: 'Changes will be communicated via email, onsite notification and/or direct message.',
  },
];

const FAQ = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack>
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          Frequently asked questions
        </Title>
        <Accordion variant="default">
          {faq.map(({ q, a }, index) => (
            <Accordion.Item key={index} value={`q${index}`}>
              <Accordion.Control>
                <Group spacing={8}>
                  <Text size="lg" weight={700}>
                    {q}
                  </Text>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>{typeof a === 'string' ? <Text>{a}</Text> : a}</Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      </Stack>
    </Stack>
  );
};

const useStyles = createStyles((theme) => ({
  highlightColor: {
    color: theme.colorScheme === 'dark' ? 'white' : 'black',
  },
  card: {
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
  highlightCard: {
    position: 'relative',
    overflow: 'hidden',

    '.mantine-Title-root': {
      fontSize: 28,
      fontWeight: 700,
    },
  },
  earnBuzzCard: {
    background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
  },
  getPaidCard: {
    background: theme.fn.linearGradient(45, theme.colors.green[5], theme.colors.green[2]),
  },
  newPerksCard: {
    background: theme.fn.linearGradient(45, theme.colors.blue[5], theme.colors.blue[2]),
  },
  highlightCardBackgroundIcon: {
    position: 'absolute',
    width: 'auto',
    height: '75%',
    top: '25%',
    right: 0,
    transform: 'translateX(35%)',
    color: theme.colors.green[9],
    opacity: 0.3,
    zIndex: 0,
  },
  section: {
    paddingTop: theme.spacing.xl * 2,
  },
}));
