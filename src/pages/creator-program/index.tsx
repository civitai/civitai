import {
  Accordion,
  Alert,
  Anchor,
  Button,
  Center,
  Container,
  createStyles,
  Divider,
  Grid,
  Group,
  List,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconQuestionMark,
  IconMoneybag,
  IconUserPlus,
  IconLogout,
  IconCircleDashed,
  IconBolt,
  IconPig,
  IconBook,
  IconPercentage10,
  IconCaretRightFilled,
  IconCircleCheck,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Currency } from '~/shared/utils/prisma/enums';
import { CurrencyIcon } from '../../components/Currency/CurrencyIcon';
import { Meta } from '../../components/Meta/Meta';
import { constants } from '../../server/common/constants';
import {
  abbreviateNumber,
  formatCurrencyForDisplay,
  numberWithCommas,
} from '../../utils/number-helpers';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { CreatorProgramRequirement } from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { getDisplayName } from '~/utils/string-helpers';
import { capitalize } from 'lodash-es';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCreatorProgramRequirements } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { openCreatorScoreModal } from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals';
import { formatDate } from '~/utils/date-helpers';
import { getCreatorProgramAvailability } from '~/server/utils/creator-program.utils';
import { Flags } from '~/shared/utils';
import { OnboardingSteps } from '~/server/common/enums';
import { Countdown } from '~/components/Countdown/Countdown';

const sizing = {
  header: {
    title: 52,
    subtitle: 28,
  },
  sections: {
    title: 32,
    subtitle: 'xl',
  },
  HowItWorks: {
    icons: 52,
    text: 'xl',
  },
  earnBuzz: {
    value: 52,
    text: 'xl',
  },
} as const;

function CreatorsClubV1() {
  const { cx, classes, theme } = useStyles();
  const currentUser = useCurrentUser();
  const applyFormUrl = `/user/buzz-dashboard`;
  const availability = getCreatorProgramAvailability();

  return (
    <>
      <Meta title="Creator Program | Civitai" />
      <Container>
        <Stack spacing="lg">
          <Title size={sizing.header.title} className={classes.highlightColor} lh={1} mb="sm">
            <Text component="span" size={32} weight={700}>
              Introducing the
            </Text>
            <br />
            Civitai Creator Program: Evolved!
          </Title>

          <Text size={sizing.header.subtitle} lh={1.3} mb="xs">
            The Civitai Creator Program is our way of supporting our talented Creator community by
            providing a path to earn from their work. Creators earn Buzz by developing and sharing
            models, and the Creator Program allows them to turn their contributions into real
            earnings!
          </Text>
          <Grid>
            <Grid.Col span={12}>
              <Paper
                withBorder
                className={cx(classes.card, classes.highlightCard, classes.earnBuzzCard)}
                h="100%"
              >
                <Stack>
                  <Group position="apart" noWrap>
                    <Title order={3} color="yellow.8">
                      Turn your Buzz into earnings!{' '}
                      {!availability.isAvailable && (
                        <>
                          Launching in <Countdown endTime={availability.availableDate} />
                        </>
                      )}
                    </Title>
                    <Group spacing={0} noWrap>
                      <IconBolt
                        style={{ fill: theme.colors.yellow[7] }}
                        size={40}
                        color="yellow.7"
                      />
                      <IconBolt
                        style={{ fill: theme.colors.yellow[7], margin: '0 -20' }}
                        size={64}
                        color="yellow.7"
                      />
                      <IconBolt
                        style={{ fill: theme.colors.yellow[7] }}
                        size={40}
                        color="yellow.7"
                      />
                    </Group>
                  </Group>
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
          <HowItWorksSection />
          <JoinSection applyFormUrl={applyFormUrl} />
          <FAQ />
        </Stack>
      </Container>
    </>
  );
}

const HowItWorks: { text: string; icon: React.ReactNode }[] = [
  {
    text: 'Earn Buzz',
    icon: <IconBolt size={sizing.HowItWorks.icons} />,
  },
  {
    text: 'Bank your Buzz',
    icon: <IconPig size={sizing.HowItWorks.icons} />,
  },
  {
    text: 'Claim your Share',
    icon: <IconPercentage10 size={sizing.HowItWorks.icons} />,
  },
];

const HowItWorksSection = () => {
  const { cx, classes, theme } = useStyles();

  return (
    <Stack className={classes.section}>
      <Stack spacing={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          How it Works
        </Title>
        <Text size={sizing.sections.subtitle}>Generating a lot of Buzz? Bank it to earn cash!</Text>
      </Stack>
      <Grid>
        {HowItWorks.map(({ text, icon }, index) => (
          <Grid.Col span={12} sm={4} key={index}>
            <Paper withBorder className={cx(classes.card)} h="100%">
              {icon}
              <Text className={classes.highlightColor} size={sizing.HowItWorks.text}>
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
                  The Basics
                </Title>
                <Group noWrap w="100%">
                  <IconUserPlus size={24} />
                  <Text>If you meet the program requirements, join!</Text>
                </Group>
                <Divider />
                <Group noWrap w="100%">
                  <IconPercentage10 size={24} />
                  <Text>
                    Each month Civitai allocates a Creator Compensation Pool from a portion of our
                    revenue
                  </Text>
                </Group>
                <Divider />
                <Group noWrap w="100%">
                  <IconPig size={24} />
                  <Text>
                    During the Banking Phase, you Bank Buzz to secure your share of the Compensation
                    Pool
                  </Text>
                </Group>
                <Divider />
                <Group noWrap w="100%">
                  <IconLogout size={24} />
                  <Text>
                    During the Extraction Phase, you can choose to keep Buzz in the Bank to get paid
                    or Extract it to save it for the future
                  </Text>
                </Group>
                <Divider />
                <Group noWrap w="100%">
                  <IconMoneybag size={24} />
                  <Text fw={700}>Get paid!</Text>
                </Group>
              </Stack>
            </Group>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

const JoinSection = ({ applyFormUrl }: { applyFormUrl: string }) => {
  const { cx, classes, theme } = useStyles();
  const { requirements, isLoading: isLoadingRequirements } = useCreatorProgramRequirements();
  const hasValidMembership = requirements?.validMembership;
  const membership = requirements?.membership;
  const hasEnoughCreatorScore =
    (requirements?.score.current ?? 0) >= (requirements?.score.min ?? 0);
  const availability = getCreatorProgramAvailability();
  const currentUser = useCurrentUser();
  const isBanned = Flags.hasFlag(
    currentUser?.onboarding ?? 0,
    OnboardingSteps.BannedCreatorProgram
  );
  const isJoined = Flags.hasFlag(currentUser?.onboarding ?? 0, OnboardingSteps.CreatorProgram);

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
                Program requirements:
              </Text>
              {isLoadingRequirements ? (
                <Center>
                  <Loader />
                </Center>
              ) : (
                <>
                  <CreatorProgramRequirement
                    isMet={hasEnoughCreatorScore}
                    title={`Have a Creator Score higher than ${abbreviateNumber(
                      requirements?.score.min ?? 10000
                    )}`}
                    content={
                      <p>
                        Your current{' '}
                        <Anchor
                          onClick={() => {
                            openCreatorScoreModal();
                          }}
                        >
                          Creator Score
                        </Anchor>{' '}
                        is {abbreviateNumber(requirements?.score.current ?? 0)}.
                      </p>
                    }
                  />
                  <CreatorProgramRequirement
                    isMet={!!membership}
                    title="Be a Civitai Member"
                    content={
                      hasValidMembership ? (
                        <p>
                          You are a {capitalize(getDisplayName(membership as string))} Member! Thank
                          you for supporting Civitai.
                        </p>
                      ) : membership ? (
                        <p>
                          You are a {capitalize(getDisplayName(membership as string))} Member. Your
                          current membership does not apply to join the Creator Program. Consider
                          upgrading to one our supported memberships.
                          <br />
                          <NextLink href="/pricing">
                            <Anchor>Upgrade Membership</Anchor>
                          </NextLink>
                        </p>
                      ) : (
                        <NextLink href="/pricing">
                          <Anchor>Become a Civitai Member Now!</Anchor>
                        </NextLink>
                      )
                    }
                  />
                </>
              )}

              <Button
                size="lg"
                mt="auto"
                rightIcon={availability.isAvailable ? <IconCaretRightFilled /> : undefined}
                leftIcon={isJoined && availability.isAvailable ? <IconCircleCheck /> : undefined}
                component="a"
                href={applyFormUrl}
                target="_blank"
                disabled={!availability.isAvailable || isBanned}
              >
                {availability.isAvailable
                  ? isJoined && !isBanned
                    ? "You've Joined"
                    : 'Join Now!'
                  : 'Coming Soon!'}
              </Button>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col xs={12} sm={6}>
          <Paper withBorder className={cx(classes.card)} h="100%">
            <Stack spacing="sm">
              <Text mb="sm" className={classes.highlightColor} size="lg">
                <strong>Want to know more? Check out the full Guide!</strong>
              </Text>
              <Group noWrap w="100%">
                <IconBook size={24} />
                <Anchor
                  href="https://education.civitai.com/civitais-guide-to-earning-with-the-creator-program/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Earning with the Creator Program
                </Anchor>
              </Group>
              <Group noWrap w="100%">
                <IconBook size={24} />
                <Anchor href="/content/creator-program-v2-tos">Terms of Service</Anchor>
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
    q: 'Is this voluntary?',
    a: 'Yes! If you’re eligible for the program, but don’t want to participate, nobody’s forcing you! Even if you do join the program, but don’t want to contribute Buzz, that’s fine – there’s no requirement to Bank anything.',
  },
  {
    q: 'Would buying a higher Membership Tier (Silver or Gold) increase my earnings?',
    a: 'Not your earnings, as such, but it does increase the maximum you can Bank each month.',
  },
  {
    q: 'Will I get my Banked Buzz back?',
    a: 'No, your Banked Buzz will be consumed each month, unless you choose to Extract it during the Extraction Phase!',
  },
  {
    q: 'What types of Buzz can be Banked?',
    a: 'Any earned Yellow Buzz can be Banked, up to your cap. This includes Buzz from sources such as Early Access, Tips, and Generator Compensation.',
  },
  {
    q: 'What happens if cancel my Civitai Membership?',
    a: 'If you deactivate your Subscription you’ll remain in the Program until the end of the month, allowing you to Bank your Buzz and withdraw through the end of the period.',
  },
  {
    q: 'When, and how, do I sign up with your Payment Partner to withdraw my cash?',
    a: 'When you have at least $50 in Ready to Withdraw status, you’ll be invited to set up your account with our Payment Partner, via the email tied to your Civitai account, and a link on the Creator Program interface.',
  },
  {
    q: 'Must I withdraw my “Ready to Withdraw” funds each month?',
    a: 'No, funds can accumulate in your account until you’re ready to pay out! There’s no requirement to pay out each month.',
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

export default function CreatorsClubIntro() {
  return CreatorsClubV1();
}

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
