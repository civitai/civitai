import {
  Container,
  createStyles,
  Stack,
  Group,
  Text,
  Title,
  Paper,
  Grid,
  Center,
  Alert,
  List,
  Accordion,
  Anchor,
} from '@mantine/core';
import {
  IconAsterisk,
  IconBolt,
  IconBrandStripe,
  IconCamera,
  IconCameraCheck,
  IconCameraDollar,
  IconCards,
  IconCash,
  IconCloudDown,
  IconCloudDownload,
  IconCreditCard,
  IconEqual,
  IconFidgetSpinner,
  IconFlower,
  IconGift,
  IconHeartHandshake,
  IconMessage,
  IconMoneybag,
  IconMoodSmile,
  IconPigMoney,
  IconRating18Plus,
  IconSpiral,
  IconUsers,
  IconWand,
  IconWindmill,
  IconWorldCheck,
} from '@tabler/icons-react';
import { formatCurrencyForDisplay, numberWithCommas } from '../../utils/number-helpers';
import { constants } from '../../server/common/constants';
import { CurrencyBadge } from '../../components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { CurrencyIcon } from '../../components/Currency/CurrencyIcon';
import { ReactNode } from 'react';

export default function CreatorsClubIntro() {
  const { cx, classes, theme } = useStyles();
  return (
    <Container>
      <Stack spacing="lg">
        <Title>
          <Text component="span" size="xl" weight={700}>
            Introducing the
          </Text>
          <br />
          Civitai Creators Program
        </Title>

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
        <Text size="lg">
          One of the core tenants of Civitai is that creators should be able to monetize their work.
          The Civitai Creators Program is the pathway for creators on Civitai to getting paid for
          their contributions
        </Text>
        <ExclusivePerksSection />
        <EarnBuzzSection />
        <JoinSection />
        <FAQ />
      </Stack>
    </Container>
  );
}

const perks: { text: string; icon: React.ReactNode }[] = [
  {
    text: 'Early access to test new creator tools',
    icon: <IconWand size={32} />,
  },
  {
    text: 'A direct comunication channel to the Civitai Team',
    icon: <IconHeartHandshake size={32} />,
  },
  {
    text: 'Civitai will pay you for your Buzz',
    icon: <IconCash size={32} />,
  },
];

const ExclusivePerksSection = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0}>
        <Title order={2} color="white">
          Exclusive perks
        </Title>
        <Text>Members of the Creator Program enjoy a number of exclusive perks</Text>
      </Stack>
      <Grid>
        {perks.map(({ text, icon }, index) => (
          <Grid.Col span={4} key={index}>
            <Paper withBorder className={cx(classes.card)} h="100%">
              {icon}
              <Text color="white">{text}</Text>
            </Paper>
          </Grid.Col>
        ))}

        <Grid.Col span={12}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            <Group position="apart">
              <Stack spacing="xs">
                <Title order={3} color="white">
                  How you&rsquo;re paid
                </Title>
                <Text>
                  Civitai will pay Creators within the program{' '}
                  <Text component="span" color="white">
                    ${formatCurrencyForDisplay(100)} USD for every{' '}
                    <CurrencyIcon
                      currency={Currency.BUZZ}
                      stroke={0}
                      style={{ position: 'relative', top: 5 }}
                    />
                    {numberWithCommas(constants.buzz.buzzDollarRatio)}
                  </Text>
                </Text>
                <Text>
                  At the time of withdrawal Civitai will{' '}
                  <Text component="span" color="white" underline>
                    take a {constants.buzz.platformFee * 100}% platform fee.
                  </Text>
                </Text>
              </Stack>
              <Stack m="auto" spacing="xs">
                <Group>
                  <CurrencyIcon size={30} currency={Currency.BUZZ} stroke={0} />
                  <Text size={24} color="white">
                    {numberWithCommas(constants.buzz.buzzDollarRatio)}
                  </Text>
                </Group>
                <Group>
                  <CurrencyIcon size={30} currency={Currency.USD} />
                  <Text size={24} color="white">
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

const customBuzzGeneration: { text: string; value: number }[] = [
  {
    value: 10,
    text: 'For every 1000 ad impressions on your images or resources',
  },
  {
    value: 10,
    text: 'For every uniqe user that downloads your early access resource',
  },
  {
    value: 10,
    text: 'for every 1000 images geenrated on-site using one of your resources',
  },
];

const EarnBuzzSection = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0}>
        <Title order={2} color="white">
          New ways to earn{' '}
          <CurrencyIcon
            currency={Currency.BUZZ}
            stroke={0}
            style={{ position: 'relative', top: 5 }}
            size={26}
          />{' '}
          Buzz
        </Title>
        <Text>As a valued member of the Creators Program, you get 3 new ways to earn buzz </Text>
      </Stack>
      <Grid>
        {customBuzzGeneration.map(({ text, value }, index) => (
          <Grid.Col xs={6} sm={4} key={index}>
            <Paper withBorder className={cx(classes.card)} h="100%">
              <Group spacing={0} position="center">
                <CurrencyIcon currency={Currency.BUZZ} stroke={0} size={26} />{' '}
                <Text color="white" size={24}>
                  {value}
                </Text>
              </Group>
              <Text color="white">{text}</Text>
            </Paper>
          </Grid.Col>
        ))}
      </Grid>
      <Alert color="yellow.6">
        <strong>NOTE:</strong> The Creator program is just getting started, so Buzz rewards will be
        tweaked over time as we dial in the right balance. This process will be transparent to all
        Creator Program members, our goal is to ensure you&rsquo;re able to monetize in a
        sustainable way.
      </Alert>
      <Text color="white" size="xs">
        <IconAsterisk color="white" size={12} /> (resources may only be in early acess for a maximum
        of 14 days and then must be made available to all users)
      </Text>
    </Stack>
  );
};

const JoinSection = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0}>
        <Title order={2} color="white">
          How do I join?
        </Title>
      </Stack>
      <Grid>
        <Grid.Col xs={12} sm={6}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            <Stack>
              <Text color="white" size="lg">
                Creators interested in joining the program must meet the following requirements:
              </Text>
              <Group position="apart" noWrap w="100%">
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
                <IconWorldCheck size={24} />
              </Group>
              <Group position="apart" noWrap w="100%">
                <Text>
                  Create a{' '}
                  <Anchor
                    href="https://dashboard.stripe.com/register"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Stripe account
                  </Anchor>{' '}
                  (We do payouts through Stripe)
                </Text>
                <IconBrandStripe size={24} />
              </Group>
              <Group position="apart" noWrap w="100%">
                <Text>Be 18 or older</Text>
                <IconRating18Plus size={24} />
              </Group>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col xs={12} sm={6}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            {' '}
            <Stack>
              <Text color="white" size="lg">
                Applications will be prioritized by the following engagement metrics:
              </Text>
              <Group position="apart" noWrap w="100%">
                <Text>Followers</Text>
                <IconUsers size={24} />
              </Group>
              <Group position="apart" noWrap w="100%">
                <Text>Unique Downloads</Text>
                <IconCloudDownload size={24} />
              </Group>
              <Group position="apart" noWrap w="100%">
                <Text>Unique Generations</Text>
                <IconWindmill size={24} />
              </Group>
              <Group position="apart" noWrap w="100%">
                <Text>Unique Reactions</Text>
                <IconMoodSmile size={24} />
              </Group>
              <Group position="apart" noWrap w="100%">
                <Text>Unique Engagement (comments/reviews)</Text>
                <IconMessage size={24} />
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
    q: 'Why a 30% platform fee on withdrawals?',
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
        You can withdraw a minimum of{' '}
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
    q: 'Can I withdraw my earnings in currencies other than USD?',
    a: 'Yes, you can withdraw in your native currency.',
  },
  {
    q: 'Can I leave the Creator Program?',
    a: 'Anytime you want. Its a voluntary program.',
  },
  {
    q: 'How will changes to the program be communicated?',
    a: 'Changes will be communicated via email, onsite notification and/or direct message.',
  },
  {
    q: 'What, if any, requirements are there to remain in the Creator Program?',
    a: (
      <Stack>
        <Text>Creators in the program are required to:</Text>
        <ul>
          <li>Be courteous and fair to the community.</li>
          <li>
            New resources or versions must be in early access. This supports you while ensuring your
            resources become available to the community
          </li>
        </ul>
      </Stack>
    ),
  },
];

const FAQ = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack>
        <Title order={2} color="white">
          Frequently asked questions
        </Title>
        <Accordion variant="default">
          {faq.map(({ q, a }, index) => (
            <Accordion.Item key={index} value={`q${index}`}>
              <Accordion.Control>
                <Group spacing={8}>
                  <Text size="lg" weight={700}>
                    Q: {q}
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
    border: `2px solid ${theme.colors.yellow[7]}`,
  },
  getPaidCard: {
    background: theme.fn.linearGradient(45, theme.colors.green[5], theme.colors.green[2]),
    border: `2px solid ${theme.colors.green[9]}`,
  },
  newPerksCard: {
    background: theme.fn.linearGradient(45, theme.colors.blue[5], theme.colors.blue[2]),
    border: `2px solid ${theme.colors.blue[9]}`,
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
