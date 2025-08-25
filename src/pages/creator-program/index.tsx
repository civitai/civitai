import {
  Accordion,
  Anchor,
  Button,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  IconMoneybag,
  IconUserPlus,
  IconLogout,
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
import {
  abbreviateNumber,
  formatToLeastDecimals,
  numberWithCommas,
} from '../../utils/number-helpers';
import {
  CompensationPoolCard,
  CreatorProgramRequirement,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2';
import { getDisplayName } from '~/utils/string-helpers';
import { capitalize } from 'lodash-es';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  useCreatorProgramRequirements,
  usePrevMonthStats,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import {
  CreatorProgramCapsInfo,
  openCreatorScoreModal,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals';
import { getCreatorProgramAvailability } from '~/server/utils/creator-program.utils';
import { Flags } from '~/shared/utils/flags';
import { OnboardingSteps } from '~/server/common/enums';
import { Countdown } from '~/components/Countdown/Countdown';
import classes from './index.module.scss';

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
  const applyFormUrl = `/user/buzz-dashboard`;
  const availability = getCreatorProgramAvailability();

  return (
    <>
      <Meta title="Creator Program | Civitai" />
      <Container>
        <Stack gap="lg">
          <Title fz={sizing.header.title} className={classes.highlightColor} lh={1} mb="sm">
            <Text component="span" fz={32} fw={700}>
              Introducing the
            </Text>
            <br />
            Civitai Creator Program: Evolved!
          </Title>

          <Text fz={sizing.header.subtitle} lh={1.3} mb="xs">
            The Civitai Creator Program is our way of supporting our talented Creator community by
            providing a path to earn from their work. Creators earn Buzz by developing and sharing
            models, and the Creator Program allows them to turn their contributions into real
            earnings!
          </Text>
          <Grid>
            <Grid.Col span={12}>
              <Paper
                withBorder
                className={`${classes.card} ${classes.highlightCard} ${classes.earnBuzzCard}`}
                h="100%"
              >
                <Stack>
                  <Group justify="space-between" wrap="nowrap">
                    <Title order={3} c="yellow.8">
                      Turn your Buzz into earnings!{' '}
                      {!availability.isAvailable && (
                        <>
                          Launching in <Countdown endTime={availability.availableDate} />
                        </>
                      )}
                    </Title>
                    <Group gap={0} wrap="nowrap">
                      <IconBolt
                        style={{ fill: 'var(--mantine-color-yellow-7)' }}
                        color="yellow.7"
                        size={40}
                      />
                      <IconBolt
                        style={{ fill: 'var(--mantine-color-yellow-7)' }}
                        color="yellow.7"
                        size={64}
                      />
                      <IconBolt
                        style={{ fill: 'var(--mantine-color-yellow-7)' }}
                        color="yellow.7"
                        size={40}
                      />
                    </Group>
                  </Group>
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
          <HowItWorksSection />
          <FunStatsSection />
          <JoinSection applyFormUrl={applyFormUrl} />
          <CreatorCapsSection />
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
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          How it Works
        </Title>
        <Text size={sizing.sections.subtitle}>Generating a lot of Buzz? Bank it to earn cash!</Text>
      </Stack>
      <Grid>
        {HowItWorks.map(({ text, icon }, index) => (
          <Grid.Col span={{ base: 12, sm: 4 }} key={index}>
            <Paper withBorder className={classes.card} h="100%">
              {icon}
              <Text className={classes.highlightColor} size={sizing.HowItWorks.text}>
                {text}
              </Text>
            </Paper>
          </Grid.Col>
        ))}

        <Grid.Col span={12}>
          <Paper withBorder className={classes.card} h="100%">
            <Group grow>
              <Stack gap="xs" maw="unset">
                <Title order={3} className={classes.highlightColor}>
                  The Basics
                </Title>
                <Group wrap="nowrap" w="100%">
                  <IconUserPlus size={24} className="flex-none" />
                  <Text>If you meet the program requirements, join!</Text>
                </Group>
                <Divider />
                <Group wrap="nowrap" w="100%">
                  <IconPercentage10 size={24} className="flex-none" />
                  <Text>
                    Each month Civitai allocates a Creator Compensation Pool from a portion of our
                    revenue
                  </Text>
                </Group>
                <Divider />
                <Group wrap="nowrap" w="100%">
                  <IconPig size={24} className="flex-none" />
                  <Text>
                    During the Banking Phase, you Bank Buzz to secure your share of the Compensation
                    Pool
                  </Text>
                </Group>
                <Divider />
                <Group wrap="nowrap" w="100%">
                  <IconLogout size={24} className="flex-none" />
                  <Text>
                    During the Extraction Phase, you can choose to keep Buzz in the Bank to get paid
                    or Extract it to save it for the future
                  </Text>
                </Group>
                <Divider />
                <Group wrap="nowrap" w="100%">
                  <IconMoneybag size={24} className="flex-none" />
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

const FunStatsSection = () => {
  const { prevMonthStats, isLoading } = usePrevMonthStats();

  if (isLoading || !prevMonthStats) {
    return <Skeleton className={classes.section} width="100%" height="200px" />;
  }

  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          Highlights from last month&apos;s cycle{' '}
        </Title>
      </Stack>
      <Paper withBorder className={classes.card} h="100%">
        <Table className="-mt-2 w-full table-auto text-base">
          <Table.Tbody>
            <Table.Tr className="font-bold">
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                Compensation Pool{' '}
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid  py-2 pl-2">
                <div className="flex items-center gap-2">
                  <span>
                    ${numberWithCommas(formatToLeastDecimals(prevMonthStats.dollarValue))}
                  </span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                # of Creators who Banked Buzz
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                <div className="flex items-center gap-2">
                  <span>{numberWithCommas(prevMonthStats.creatorCount)}</span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                Total Banked Buzz
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>
                    {numberWithCommas(
                      prevMonthStats.totalBankedBuzz + prevMonthStats.totalExtractedBuzz
                    )}
                  </span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                # of Creators who Extracted Buzz
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                <div className="flex items-center gap-2">
                  <span>{numberWithCommas(prevMonthStats.extractedCreatorCount)}</span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                Total Buzz Extracted
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>{numberWithCommas(prevMonthStats.totalExtractedBuzz)}</span>
                </div>
              </Table.Td>
            </Table.Tr>

            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                <div className="flex items-center gap-1">
                  <span>Total Payout Buzz</span>
                </div>
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>{numberWithCommas(prevMonthStats.totalBankedBuzz)}</span>
                </div>{' '}
              </Table.Td>
            </Table.Tr>

            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                # of Creators who cashed out
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                <div className="flex items-center gap-2">
                  <span>{numberWithCommas(prevMonthStats.cashedOutCreatorCount)}</span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                <div className="flex items-center gap-1">
                  <span>$ per 1,000 Buzz Banked</span>
                </div>
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                $
                {numberWithCommas(
                  formatToLeastDecimals(prevMonthStats.dollarAmountPerThousand ?? 0)
                )}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                <div className="flex items-center gap-1">
                  <span>Highest payout</span>
                </div>
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                ${numberWithCommas(formatToLeastDecimals(prevMonthStats.dollarHighestEarned ?? 0))}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-0 border-b border-solid">
                <div className="flex items-center gap-1">
                  <span>Average payout</span>
                </div>
              </Table.Td>
              <Table.Td className="border-0 border-b border-l border-solid py-2 pl-2">
                ${numberWithCommas(formatToLeastDecimals(prevMonthStats.dollarAverageEarned ?? 0))}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2}>
                <div className="flex items-center gap-1">
                  <span>Median payout</span>
                </div>
              </Table.Td>
              <Table.Td className="border-0 border-l border-solid py-2 pl-2">
                ${numberWithCommas(formatToLeastDecimals(prevMonthStats.dollarMedianEarned ?? 0))}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
};
const JoinSection = ({ applyFormUrl }: { applyFormUrl: string }) => {
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
      <Stack gap={0} mb="sm">
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          How do I join?
        </Title>
      </Stack>
      <Grid>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Paper withBorder className={classes.card} h="100%">
            <Stack gap="sm" h="100%">
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
                      <p className="my-0">
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
                        <p className="my-0">
                          You are a {capitalize(getDisplayName(membership as string))} Member! Thank
                          you for supporting Civitai.
                        </p>
                      ) : membership ? (
                        <p className="my-0">
                          You are a {capitalize(getDisplayName(membership as string))} Member. Your
                          current membership does not apply to join the Creator Program. Consider
                          upgrading to one our supported memberships.
                          <br />
                          <Anchor component={NextLink} href="/pricing">
                            Upgrade Membership
                          </Anchor>
                        </p>
                      ) : (
                        <Anchor component={NextLink} href="/pricing">
                          Become a Civitai Member Now!
                        </Anchor>
                      )
                    }
                  />
                </>
              )}

              <Button
                size="lg"
                mt="auto"
                rightSection={availability.isAvailable ? <IconCaretRightFilled /> : undefined}
                leftSection={isJoined && availability.isAvailable ? <IconCircleCheck /> : undefined}
                component="a"
                href={applyFormUrl}
                target="_blank"
                disabled={
                  !availability.isAvailable ||
                  isBanned ||
                  !hasValidMembership ||
                  !hasEnoughCreatorScore
                }
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
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Paper withBorder className={classes.card} h="100%">
            <Stack gap="sm">
              <Text mb="sm" className={classes.highlightColor} size="lg">
                <strong>Want to know more? Check out the full Guide!</strong>
              </Text>
              <Group wrap="nowrap" w="100%">
                <IconBook size={24} />
                <Anchor
                  href="https://education.civitai.com/civitais-guide-to-earning-with-the-creator-program/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Earning with the Creator Program
                </Anchor>
              </Group>
              <Group wrap="nowrap" w="100%">
                <IconBook size={24} />
                <Anchor href="/content/creator-program-v2-tos">Terms of Service</Anchor>
              </Group>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <CompensationPoolCard />
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

const faq: { q: string; a: string | React.ReactNode }[] = [
  {
    q: 'Is this voluntary?',
    a: `Yes! If you're eligible for the program, but don't want to participate, nobody's forcing you! Even if you do join the program, but don't want to contribute Buzz, that's fine – there's no requirement to Bank anything.`,
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
    a: `If you deactivate your Subscription you'll remain in the Program until the end of the month, allowing you to Bank your Buzz and withdraw through the end of the period.`,
  },
  {
    q: 'When, and how, do I sign up with your Payment Partner to withdraw my cash?',
    a: `When you have at least $50 in Ready to Withdraw status, you'll be invited to set up your account with our Payment Partner, via the email tied to your Civitai account, and a link on the Creator Program interface.`,
  },
  {
    q: 'Must I withdraw my “Ready to Withdraw” funds each month?',
    a: `No, funds can accumulate in your account until you're ready to pay out! There's no requirement to pay out each month.`,
  },
  {
    q: 'What happens if I decide I want my Banked Buzz back?',
    a: `The last three days of each month make up the Extraction Phase, during which you can reclaim your Buzz back to your Buzz Wallet if you choose not to proceed with a payout. Extractions must be all or nothing - you cannot partially Extract your Buzz. A tiered fee structure is in place to prevent Bank manipulation: the first 100k Buzz is fee-free, the next 900k Buzz is charged a 5% Extraction fee, the next 4M Buzz is charged a 10% Extraction fee, and any amount above 5M Buzz is charged a 15% Extraction fee.`,
  },
];

const FAQ = () => {
  return (
    <Stack className={classes.section}>
      <Stack>
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          Frequently asked questions
        </Title>
        <Accordion variant="default" classNames={{ control: 'py-4' }}>
          {faq.map(({ q, a }, index) => (
            <Accordion.Item key={index} value={`q${index}`}>
              <Accordion.Control>
                <Group gap={8}>
                  <Text size="lg" fw={700}>
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

const CreatorCapsSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          Creator Banking Caps
        </Title>
      </Stack>
      <Paper withBorder className={classes.card} h="100%">
        <CreatorProgramCapsInfo />
      </Paper>
    </Stack>
  );
};

export default function CreatorsClubIntro() {
  return CreatorsClubV1();
}
