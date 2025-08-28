import { Alert, Center, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import * as z from 'zod';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import animationClasses from '~/libs/animations.module.scss';
import { BuzzPurchaseImproved } from '~/components/Buzz/BuzzPurchaseImproved';

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
          destination: `https://${
            env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN || 'civitai'
          }/purchase/buzz?sync-account=blue`,
          statusCode: 302,
          basePath: false,
        },
      };
  },
});

const schema = z.object({
  returnUrl: z.string().optional(),
  minBuzzAmount: z.coerce.number().optional(),
  success: z.string().optional(),
});

export default function PurchaseBuzz() {
  const router = useRouter();
  const { returnUrl, minBuzzAmount, success: successParam } = schema.parse(router.query);
  const [success, setSuccess] = useState<boolean>(successParam === 'true');

  const handlePurchaseSuccess = () => {
    if (returnUrl) {
      window.open(returnUrl, '_blank');
    }

    setSuccess(true);
  };

  if (success) {
    return (
      <Container size="md" mb="lg">
        <Center className={animationClasses.jelloFall}>
          <EdgeMedia src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
        </Center>
        <Title order={1} className="text-center">
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
              <Title order={3} className="text-center">
                Where to go from here?
              </Title>
              <BuzzFeatures variant="list" showHeader={false} compact={false} />
            </Stack>
          )}
        </Center>
      </Container>
    );
  }

  return (
    <Container size="xl" mb="lg" pt="sm">
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
      <BuzzPurchaseImproved
        onPurchaseSuccess={handlePurchaseSuccess}
        minBuzzAmount={minBuzzAmount}
        purchaseSuccessMessage={
          returnUrl
            ? (purchasedBalance) => (
                <Stack>
                  <Text>Thank you for your purchase!</Text>
                  <Text>
                    We have added{' '}
                    <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to your
                    account. You can now close this window and return to the previous site.
                  </Text>
                </Stack>
              )
            : undefined
        }
      />
    </Container>
  );
}
