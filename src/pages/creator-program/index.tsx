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
  IconTrendingUp,
  IconLicense,
  IconLock,
  IconCoin,
  IconHeart,
  IconClock,
  IconShoppingBag,
  IconChartBar,
  IconArrowRight,
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
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CreatorProgramCapsInfo } from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals';
import { getCreatorProgramAvailability } from '~/server/utils/creator-program.utils';
import { Flags } from '~/shared/utils/flags';
import { OnboardingSteps } from '~/server/common/enums';
import { Countdown } from '~/components/Countdown/Countdown';
import classes from './index.module.scss';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';

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

const CREATOR_STUDIO_URL = 'https://creator-studio.civitai.com';

function CreatorsClubV1() {
  const applyFormUrl = `/user/buzz-dashboard`;

  return (
    <>
      <Meta title="Earn on Civitai | Civitai" canonical="/creator-program" />

      {/* Zone 1 — being a creator on Civitai */}
      <Container>
        <Stack gap="lg">
          <Stack gap="xs">
            <Title fz={sizing.header.title} className={classes.highlightColor} lh={1}>
              Earn on Civitai
            </Title>
            <Text fz={sizing.header.subtitle} lh={1.3}>
              Your models, LoRAs, and images power Civitai. Here&apos;s every way to earn from your
              work — and how the Creator Program lets you turn the Buzz you earn into real payouts.
            </Text>
          </Stack>

          <WhyCreatorsMatterSection />
          <HowYouEarnSection />
          <CreatorStudioSection />
        </Stack>
      </Container>

      {/* Zone 2 — the Creator Program (distinct band) */}
      <div className={classes.programBand}>
        <Container>
          <Stack gap="lg">
            <ProgramIntro applyFormUrl={applyFormUrl} />
            <MonetizationCapsSection />
            <HowItWorksSection />
            <FunStatsSection />
            <JoinSection applyFormUrl={applyFormUrl} />
            <CreatorCapsSection />
            <ProgramJoinCta applyFormUrl={applyFormUrl} />
          </Stack>
        </Container>
      </div>

      {/* Zone 3 — FAQ */}
      <Container>
        <FAQ />
      </Container>
    </>
  );
}

const WhyCreatorsMatterSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          You make Civitai
        </Title>
      </Stack>
      <Paper withBorder className={classes.card} h="100%">
        <Text size="lg">
          Every model, LoRA, and image posted here is what brings people to Civitai and keeps them
          generating. When your work drives that activity, you should share in what it creates —
          that&apos;s what earning on Civitai is all about, whether you&apos;re building models or
          filling the feeds with great generations.
        </Text>
      </Paper>
    </Stack>
  );
};

const earnMethods: { text: string; description: string; icon: React.ReactNode }[] = [
  {
    text: 'Generation compensation',
    description: 'Earn every time someone generates with your models.',
    icon: <IconBolt size={28} />,
  },
  {
    text: 'Generator tips',
    description: 'Receive tips from the people generating with your work.',
    icon: <IconCoin size={28} />,
  },
  {
    text: 'Image rewards',
    description: 'Earn Buzz when the community reacts to the images you post.',
    icon: <IconHeart size={28} />,
  },
  {
    text: 'Early access',
    description: 'Offer timed early access to your newest models.',
    icon: <IconClock size={28} />,
  },
  {
    text: 'Paid access',
    description: 'Sell permanent access to your models.',
    icon: <IconLock size={28} />,
  },
  {
    text: 'Licensing fees',
    description: 'Set a per-generation fee on your models.',
    icon: <IconLicense size={28} />,
  },
  {
    text: 'Creator Shops',
    description: 'Sell custom cosmetics, your models, and soon merch, right on your profile.',
    icon: <IconShoppingBag size={28} />,
  },
];

const HowYouEarnSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          How you earn
        </Title>
        <Text size={sizing.sections.subtitle}>
          Every creator earns from their work — no membership required. These are open to everyone.
        </Text>
      </Stack>
      <Grid>
        {earnMethods.map(({ text, description, icon }, index) => (
          <Grid.Col span={{ base: 12, sm: 6, md: 4 }} key={index}>
            <Paper withBorder className={classes.card}>
              <Stack className={classes.earnCard}>
                {icon}
                <Text className={classes.highlightColor} size="lg" fw={700}>
                  {text}
                </Text>
                <Text>{description}</Text>
              </Stack>
            </Paper>
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
};

const CreatorStudioSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          Manage it all in the Creator Studio
        </Title>
      </Stack>
      <Paper withBorder className={classes.card} h="100%">
        <Group justify="space-between" wrap="nowrap" align="center">
          <Stack gap="sm">
            <Group wrap="nowrap">
              <IconChartBar size={24} className="flex-none" />
              <Text>
                See your earnings and analytics, set licensing fees and paid access, and bulk-edit
                across your whole catalogue — all in one place. The Creator Studio is open to every
                creator.
              </Text>
            </Group>
          </Stack>
          <Button
            component="a"
            href={CREATOR_STUDIO_URL}
            target="_blank"
            rel="noopener noreferrer"
            size="lg"
            rightSection={<IconArrowRight size={18} />}
            className="flex-none"
          >
            Open Creator Studio
          </Button>
        </Group>
      </Paper>
    </Stack>
  );
};

const ProgramIntro = ({ applyFormUrl }: { applyFormUrl: string }) => {
  const availability = getCreatorProgramAvailability();
  return (
    <Stack gap="sm">
      <Title fz={40} order={2} className={classes.bandHeader} lh={1}>
        The Civitai Creator Program
      </Title>
      <Text fz={sizing.header.subtitle} lh={1.3}>
        Get paid for your work.
      </Text>
      <Text size="lg" maw={720}>
        The Creator Program is how you earn more and unlock the ability to cash out. Bank the Buzz
        you earn to claim your share of our monthly Creator Compensation Pool, then get paid your
        share.
      </Text>
      <Group>
        <Button
          component="a"
          href={applyFormUrl}
          target="_blank"
          size="lg"
          color="green"
          rightSection={availability.isAvailable ? <IconCaretRightFilled /> : undefined}
          disabled={!availability.isAvailable}
        >
          {availability.isAvailable ? (
            'Join the Creator Program'
          ) : (
            <>
              Launching in <Countdown endTime={availability.availableDate} />
            </>
          )}
        </Button>
      </Group>
    </Stack>
  );
};

const ProgramJoinCta = ({ applyFormUrl }: { applyFormUrl: string }) => {
  const availability = getCreatorProgramAvailability();
  if (!availability.isAvailable) return null;
  return (
    <Center className={classes.section}>
      <Stack align="center" gap="sm">
        <Title order={3} className={classes.bandHeader} ta="center">
          Ready to get paid for your work?
        </Title>
        <Button
          component="a"
          href={applyFormUrl}
          target="_blank"
          size="xl"
          color="green"
          rightSection={<IconCaretRightFilled />}
        >
          Join the Creator Program
        </Button>
      </Stack>
    </Center>
  );
};

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
  const [mainBuzzType] = useAvailableBuzz();
  const { colorRgb: greenColorRgb } = useBuzzCurrencyConfig(mainBuzzType);
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          How cash-out works
        </Title>
        <Text size={sizing.sections.subtitle}>
          Generating a lot of Buzz? Bank it to claim your share of the pool.
        </Text>
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
                  <Text
                    style={{
                      '--buzz-color': greenColorRgb,
                    }}
                  >
                    Each month Civitai allocates a Creator Compensation Pool from a portion of our
                    revenue based off of{' '}
                    <Text component="span" fw={700} className="font-bold text-buzz">
                      Buzz
                    </Text>{' '}
                    purchased.
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

  if (isLoading) {
    return <Skeleton className={classes.section} width="100%" height="200px" />;
  }

  if (!prevMonthStats) return null;

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
                  <span>Payout per 1,000 Buzz banked</span>
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
                        <Anchor component={NextLink} href="/user/account#creator-score">
                          Creator Score
                        </Anchor>{' '}
                        is{' '}
                        <Anchor component={NextLink} href="/user/account#creator-score">
                          {abbreviateNumber(requirements?.score.current ?? 0)}
                        </Anchor>
                        .
                      </p>
                    }
                  />
                  <CreatorProgramRequirement
                    isMet={!!membership}
                    title="Be a Civitai Green Member"
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
    q: 'Do I need a membership to earn on Civitai?',
    a: 'No. Generation compensation, tips, image rewards, early access, paid access, licensing fees, and Creator Shops are open to every creator, member or not. The Creator Program is how you earn more and unlock the ability to cash out your Buzz.',
  },
  {
    q: "What's the difference between earning Buzz and the Creator Program?",
    a: 'You earn Buzz from your work automatically as people generate with, tip, and react to it. The Creator Program lets you bank that Buzz to claim a share of the monthly Creator Compensation Pool and get paid.',
  },
  {
    q: 'Where do I manage my fees, paid access, and earnings?',
    a: (
      <Text>
        In the{' '}
        <Anchor href={CREATOR_STUDIO_URL} target="_blank" rel="noopener noreferrer">
          Creator Studio
        </Anchor>
        . It shows your earnings and analytics and lets you set licensing fees and paid access
        across your models. It&apos;s open to every creator.
      </Text>
    ),
  },
  {
    q: 'Is the Creator Program voluntary?',
    a: `Yes! If you're eligible for the program, but don't want to participate, nobody's forcing you! Even if you do join the program, but don't want to contribute Buzz, that's fine – there's no requirement to Bank anything.`,
  },
  {
    q: 'Can I bank both Yellow and Green Buzz?',
    a: `Yes! There is a single unified Compensation Pool. You can bank either Yellow or Green Buzz (or both) into the same pool each month. Your earnings are based on your total banked Buzz across both types.`,
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
    a: 'Any earned Yellow or Green Buzz can be Banked, up to your cap. This includes Buzz from sources such as Early Access, Tips, and Generator Compensation.',
  },
  {
    q: 'Do I need an active membership to Bank Buzz?',
    a: 'Yes, you must have an active Civitai membership to bank Buzz in the Creator Program. If your membership expires, you will not be able to bank additional Buzz until you renew your subscription.',
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

const MonetizationCapsSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          Charge more as you climb
        </Title>
        <Text size={sizing.sections.subtitle}>
          Every creator can monetize their work — your membership tier decides how much you can
          charge. The higher your tier, the higher your caps.
        </Text>
      </Stack>
      <Paper withBorder className={classes.card} h="100%">
        <Stack gap="sm" maw="unset">
          <Group wrap="nowrap" w="100%">
            <IconLicense size={24} className="flex-none" />
            <Text>
              <Text component="span" fw={700}>
                Higher licensing fee caps.
              </Text>{' '}
              Set a per-generation licensing fee on your models and raise your ceiling as you move
              up tiers — Bronze, Silver, then Gold each unlock a higher maximum fee.
            </Text>
          </Group>
          <Divider />
          <Group wrap="nowrap" w="100%">
            <IconLock size={24} className="flex-none" />
            <Text>
              <Text component="span" fw={700}>
                Higher paid-access price caps.
              </Text>{' '}
              Charge for early or permanent access to your resources. Higher tiers let you set
              higher access prices, so top-tier members can price their most in-demand work
              accordingly.
            </Text>
          </Group>
          <Divider />
          <Group wrap="nowrap" w="100%">
            <IconTrendingUp size={24} className="flex-none" />
            <Text>
              Your caps scale with your tier —{' '}
              <Text component="span" fw={700}>
                Free
              </Text>{' '}
              to{' '}
              <Text component="span" fw={700}>
                Bronze
              </Text>{' '}
              to{' '}
              <Text component="span" fw={700}>
                Silver
              </Text>{' '}
              to{' '}
              <Text component="span" fw={700}>
                Gold
              </Text>{' '}
              — so upgrading your membership raises how much you can earn per resource.{' '}
              <Anchor component={NextLink} href="/pricing">
                Compare membership tiers
              </Anchor>
              .
            </Text>
          </Group>
        </Stack>
      </Paper>
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
