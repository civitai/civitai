import { Card, Container, Group, NumberInput, Stack, Text, Title } from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBolt, IconCategory, IconPercentage } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { abbreviateNumber, formatToLeastDecimals, numberWithCommas } from '~/utils/number-helpers';
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
  const [earlyAccessRatio, setEarlyAccessRatio] = useState<number>(10);
  const [earlyAccessPrice, setEarlyAccessPrice] = useState<number>(1000);
  const [earlyAccessResources, setEarlyAccessResources] = useState<number>(1);
  const { query } = useRouter();

  const { data: potential, isLoading } = trpc.buzz.getEarnPotential.useQuery({
    username: query.username as string,
  });

  const currencyBadgeProps = {
    currency: Currency.BUZZ,
    loading: isLoading,
    formatter: abbreviateNumber,
  };
  const earlyAccessPotential =
    (potential?.users ?? 0) * earlyAccessPrice * earlyAccessResources * (earlyAccessRatio / 100);

  const generationDetails: DescriptionTableProps['items'] = [
    {
      label: 'Gen Count',
      info: 'The number of generations using your resources in the last 30 days',
      value: numberWithCommas(potential?.jobs),
    },
    {
      label: 'Avg. Price',
      info: 'The average price of jobs generated using your resources in the last 30 days',
      value: (
        <CurrencyBadge
          unitAmount={potential?.avg_job_cost ?? 0}
          {...currencyBadgeProps}
          formatter={(v) => formatToLeastDecimals(v, 1).toString()}
        />
      ),
    },
    {
      label: 'Avg. Share of Rewards',
      info: 'The average share of the Creator Rewards you would have received for each job generated using your resources in the last 30 days',
      value: formatToLeastDecimals((potential?.avg_ownership ?? 0) * 100, 1) + '%',
    },
    {
      label: 'Potential Rewards (25%)',
      info: 'We give 25% of the Buzz spent in the generator to Creators. You get your share of this based on the resources you provide. This is an estimate of your potential earnings based on the use of your resources in the Civitai generator over the last 30 days.',
      value: <CurrencyBadge unitAmount={potential?.total_comp ?? 0} {...currencyBadgeProps} />,
    },
    {
      label: 'Potential Tips (25%)',
      info: 'We include a 25% tip by default in the generator. This tip is then distributed to Creators based on the resources they provide. This is an estimate of your potential earnings based on the use of your resources in the Civitai generator over the last 30 days.',
      value: <CurrencyBadge unitAmount={potential?.total_tips ?? 0} {...currencyBadgeProps} />,
    },
    {
      label: 'Potential Generation Earnings',
      info: 'This is the sum of the Potential Rewards and Potential Tips you could have earned in the last 30 days.',
      value: (
        <CurrencyBadge
          unitAmount={potential?.total ?? 0}
          {...currencyBadgeProps}
          size="lg"
          sx={{ fontWeight: 900, fontSize: 16 }}
        />
      ),
    },
  ];

  const earlyAccessDetails: DescriptionTableProps['items'] = [
    {
      label: 'Potential Users',
      info: 'The number of unique users who have used your resources in the last 30 days',
      value: numberWithCommas(potential?.users ?? 0),
    },
    {
      label: 'Access Price',
      info: 'The amount you want to charge for early access to your resources',
      value: (
        <NumberInput
          value={earlyAccessPrice}
          onChange={(v) => setEarlyAccessPrice(v ?? 100)}
          min={100}
          max={10000}
          step={100}
          icon={<IconBolt />}
        />
      ),
    },
    {
      label: 'Resource Count',
      info: 'The number of resources you plan to put into early access',
      value: (
        <NumberInput
          value={earlyAccessResources}
          onChange={(v) => setEarlyAccessResources(v ?? 1)}
          min={1}
          max={20}
          step={1}
          icon={<IconCategory />}
        />
      ),
    },
    {
      label: 'Purchase Rate',
      info: 'The percentage of users who will purchase early access to your resources',
      value: (
        <NumberInput
          value={earlyAccessRatio}
          onChange={(v) => setEarlyAccessRatio(v ?? 1)}
          min={1}
          max={100}
          step={1}
          icon={<IconPercentage />}
        />
      ),
    },
    {
      label: 'Potential Early Access Earnings',
      info: 'This is an estimate based on the potential users, access price, resource count, and purchase rate you chose.',
      value: (
        <CurrencyBadge
          unitAmount={earlyAccessPotential}
          {...currencyBadgeProps}
          size="lg"
          sx={{ fontWeight: 900, fontSize: 16 }}
        />
      ),
    },
  ];

  return (
    <Container size="md">
      <Stack>
        <Stack spacing={0}>
          <Title mb={0}>Your Monthly Generation Earning Potential</Title>
          <Text color="dimmed">
            This is an estimate of your potential earnings based on the use of your resources in the
            Civitai generator over the last 30 days.
          </Text>
        </Stack>
        <Card p={0} withBorder shadow="xs">
          <Card.Section withBorder p="xs">
            <Text weight={500} size="lg">
              Generation Earning Potential
            </Text>
          </Card.Section>
          <DescriptionTable
            items={generationDetails}
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
        <Card p={0} withBorder shadow="xs">
          <Card.Section withBorder p="xs">
            <Text weight={500} size="lg">
              Early Access Earning Potential
            </Text>
          </Card.Section>
          <DescriptionTable
            items={earlyAccessDetails}
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
            Total Potential Earnings:
          </Text>
          <CurrencyBadge
            unitAmount={earlyAccessPotential + (potential?.total ?? 0)}
            {...currencyBadgeProps}
            size="xl"
            sx={{ fontWeight: 900, fontSize: 24 }}
          />
        </Group>
      </Stack>
    </Container>
  );
}
