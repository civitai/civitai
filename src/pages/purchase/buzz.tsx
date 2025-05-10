import {
  Alert,
  Center,
  Container,
  Divider,
  Group,
  List,
  ListProps,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { z } from 'zod';
import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { env } from '~/env/client';
import { BUZZ_FEATURE_LIST } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    // Avoids redirecting when a sync is about to happen.
    if (!session && !ctx.resolvedUrl.includes('sync-account='))
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'purchase-buzz' }),
          permanent: false,
        },
      };

    if (!features?.canBuyBuzz)
      return {
        redirect: {
          destination: `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/purchase/buzz?sync-account=blue`,
          statusCode: 302,
          basePath: false,
        },
      };
  },
});

const schema = z.object({
  returnUrl: z.string().optional(),
  minBuzzAmount: z.coerce.number().optional(),
});

const BuzzFeatures = (props: Omit<ListProps, 'children'>) => {
  return (
    <List listStyleType="none" gap="sm" {...props}>
      {BUZZ_FEATURE_LIST.map((feature) => (
        <List.Item key={feature}>
          <Group wrap="nowrap">
            <CurrencyIcon style={{ flexShrink: 0 }} currency={Currency.BUZZ} size={18} />
            <Text>{feature}</Text>
          </Group>
        </List.Item>
      ))}
    </List>
  );
};
export default function PurchaseBuzz() {
  const router = useRouter();
  const { returnUrl, minBuzzAmount } = schema.parse(router.query);
  const [success, setSuccess] = useState<boolean>(false);

  const handlePurchaseSuccess = () => {
    if (returnUrl) {
      window.open(returnUrl, '_blank');
    }

    setSuccess(true);
  };

  if (success) {
    return (
      <Container size="md" mb="lg">
        <Center
          sx={{
            animationName: `enterFall, jelloVertical`,
            animationDuration: `1.5s, 2s`,
            animationDelay: `0s, 1.5s`,
            animationIterationCount: '1, 1',
          }}
        >
          <EdgeMedia src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
        </Center>
        <Title order={1} align="center">
          Thank you! 🎉
        </Title>
        <Text size="lg" align="center" mb="lg">
          Your Buzz has been added to your account and you&rsquo;re ready to start using it!
        </Text>
        <Divider my="md" />
        <Center>
          {minBuzzAmount ? (
            <Stack>
              <Text align="center" mt="lg">
                You can now close this window and return to the previous window
                <br /> to continue with your action!
              </Text>
            </Stack>
          ) : (
            <Stack>
              <Title order={3} align="center">
                Where to go from here?
              </Title>
              <BuzzFeatures />
            </Stack>
          )}
        </Center>
      </Container>
    );
  }

  return (
    <Container size="md" mb="lg">
      {minBuzzAmount && (
        <Alert radius="sm" color="info" mb="xl">
          <Stack gap={0}>
            <Text>
              The action you are trying to perform requires you to purchase a minimum of
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={minBuzzAmount} /> to continue.
            </Text>

            <Text>
              Once you have purchased the required amount, you can close this window and return to
              the previous site to continue with your action.
            </Text>
          </Stack>
        </Alert>
      )}
      <Alert radius="sm" color="yellow" style={{ zIndex: 10 }} mb="xl">
        <Group gap="xs" wrap="nowrap" justify="center">
          <CurrencyIcon currency={Currency.BUZZ} size={24} />
          <Title order={2}>Buy Buzz now</Title>
        </Group>
      </Alert>
      <ContainerGrid gutter={48}>
        <ContainerGrid.Col xs={12} md={4}>
          <Stack>
            <Title order={2}>Buzz Benefits</Title>
            <BuzzFeatures />
          </Stack>
        </ContainerGrid.Col>
        <ContainerGrid.Col xs={12} md={8}>
          <BuzzPurchase
            onPurchaseSuccess={handlePurchaseSuccess}
            minBuzzAmount={minBuzzAmount}
            purchaseSuccessMessage={
              returnUrl
                ? (purchasedBalance) => (
                    <Stack>
                      <Text>Thank you for your purchase!</Text>
                      <Text>
                        We have added{' '}
                        <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
                        your account. You can now close this window and return to the previous site.
                      </Text>
                    </Stack>
                  )
                : undefined
            }
          />
        </ContainerGrid.Col>
      </ContainerGrid>
    </Container>
  );
}
