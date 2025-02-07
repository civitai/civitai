import { Card, Container, Group, NumberInput, Stack, Text, Title } from '@mantine/core';
import { IconPercentage } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});



export default function EarnPotential() {
  const [bankPortion, setBankPortion] = useState<number>(50);
  const [creatorBankPortion, setCreatorBankPortion] = useState<number>(100);
  const { query } = useRouter();
  const features = useFeatureFlags();

  const { data: potential, isLoading } = trpc.buzz.getPoolForecast.useQuery(
    { username: query.username as string },
    { enabled: features.buzz }
  );
  const poolValue = potential?.poolValue ?? 0;
  const poolSize = potential?.poolSize ?? 0;
  const earned = potential?.earned ?? 0;


  const bankedBuzz = poolSize * bankPortion/100;
  const creatorBankedBuzz = earned * creatorBankPortion/100;
  const rewardRate = Math.min(poolValue/bankedBuzz, 1/1000);
  const forecastedEarning = rewardRate * creatorBankedBuzz;

  const buzzCurrencyProps = {
    currency: Currency.BUZZ,
    loading: isLoading,
    formatter: abbreviateNumber,
  };
  const dollarCurrencyProps = {
    currency: Currency.USD,
    loading: isLoading,
    formatter: (x: number) => abbreviateNumber(x, { decimals: 2 }),
  };

  const poolDetails: DescriptionTableProps['items'] = [
    {
      label: 'Pool Value',
      info: 'The total $ value of the Creator Compensation Pool for this month, based on a % of platform revenue. Amount varies monthly.',
      value: <CurrencyBadge
          unitAmount={poolValue}
          size="lg"
          {...dollarCurrencyProps}
        />,
    },
    {
      label: 'Buzz Earned by All Creators',
      info: 'The total amount of Buzz earned by all Creators last month.',
      value: <CurrencyBadge
          unitAmount={poolSize}
          size="lg"
          {...buzzCurrencyProps}
        />,
    },
    {
      label: 'Portion of All Earned-Buzz Banked',
      info: 'The portion of all earned-Buzz banked by Creators this month.',
      value: (
        <NumberInput
          value={bankPortion}
          onChange={(v) => setBankPortion(v ?? 50)}
          min={10}
          max={80}
          step={5}
          icon={<IconPercentage />}
        />
      ),
    },
    {
      label: 'Pool Size',
      info: 'The total amount of Buzz in the pool.',
      value: <CurrencyBadge
          unitAmount={bankedBuzz}
          size="lg"
          {...buzzCurrencyProps}
        />,
    },
    {
      label: 'Your Buzz Earned',
      info: 'The total amount of Buzz you earned last month, including Creator Compensation, Generation Tips, Early Access.',
      value: <CurrencyBadge
          unitAmount={earned}
          size="lg"
          {...buzzCurrencyProps}
        />,
    },
    {
      label: 'Your Bank Portion',
      info: 'The amount of Earned-Buzz you plan to Bank',
      value: (
        <NumberInput
          value={creatorBankPortion}
          onChange={(v) => setCreatorBankPortion(v ?? 50)}
          min={10}
          max={100}
          step={5}
          icon={<IconPercentage />}
        />
      ),
    },
    {
      label: 'Your Banked Buzz',
      info: 'The total Earned-Buzz you\'re choosing to contribute to the pool.',
      value: <CurrencyBadge
          unitAmount={creatorBankedBuzz}
          size="lg"
          {...buzzCurrencyProps}
        />,
    },
  ];

  return (
    <>
      <Meta deIndex />
      <Container size="md">
        <Stack>
          <Stack spacing={0}>
            <Title mb={0}>Estimated Creator Compensation Pool Earnings</Title>
            <Text color="dimmed">
              This is an estimate of your potential earnings from the Creator Compensation Pool based on your earnings last month as well as the total earnings of all creators on the platform.
            </Text>
          </Stack>
          <Card p={0} withBorder shadow="xs">
            <Card.Section withBorder p="xs">
              <Text weight={500} size="lg">
                Pool Earning Factors
              </Text>
            </Card.Section>
            <DescriptionTable
              items={poolDetails}
              labelWidth="30%"
              paperProps={{
                sx: {
                  borderLeft: 0,
                  borderRight: 0,
                  borderBottom: 0,
                },
                radius: 0,
              }}
            />
          </Card>
          <Group>
            <Text size="xl" weight={900}>
              Estimated Earnings:
            </Text>
            <CurrencyBadge
              unitAmount={forecastedEarning}
              {...dollarCurrencyProps}
              size="xl"
              sx={{ fontWeight: 900, fontSize: 24 }}
            />
          </Group>
          <Text size="xs" c="dimmed">About ${(rewardRate * 1000).toFixed(2)} per ⚡1,000 Buzz Banked</Text>
          {rewardRate >= (1/1000) && (
            <Text mt={-16} size="xs" c="dimmed">The Buzz earning rate is capped at $1.00 per ⚡1,000 Buzz Banked</Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
