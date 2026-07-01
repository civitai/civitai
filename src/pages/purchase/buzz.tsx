import {
  Alert,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconGift } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import * as z from 'zod';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';
import { BuzzPurchaseLayout } from '~/components/Buzz/BuzzPurchaseLayout';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import animationClasses from '~/libs/animations.module.scss';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    // Avoids redirecting when a sync is about to happen.
    if (!session && !ctx.resolvedUrl.includes('sync-account='))
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'purchase-buzz' }),
          permanent: false,
        },
      };
  },
});

const schema = z.object({
  returnUrl: z.string().optional(),
  minBuzzAmount: z.coerce.number().optional(),
  buzzType: z.enum(['yellow', 'green', 'red']).optional(),
  success: z.string().optional(),
});

export default function PurchaseBuzz() {
  const router = useRouter();
  const features = useFeatureFlags();
  const { returnUrl, minBuzzAmount, buzzType, success: successParam } = schema.parse(router.query);
  const [success, setSuccess] = useState<boolean>(successParam === 'true');

  // On blue/red domains Buzz can only be bought with crypto (no standard card
  // payments). Gift cards, however, are credit-card payable — point users there.
  // `features.giftCards` is the master kill switch (blue/red only, Flipt-gated),
  // so the banner disappears the moment the gift-card experience is turned off.
  const cryptoOnly = !(features.isGreen || buzzType === 'green');
  const showGiftCardBanner = cryptoOnly && features.giftCards;

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
              <BuzzFeatures buzzType={buzzType} variant="list" showHeader={false} compact={false} />
            </Stack>
          )}
        </Center>
      </Container>
    );
  }

  return (
    <Container size="xl" mb="lg" pt="sm">
      {showGiftCardBanner && (
        <Card
          withBorder
          radius="md"
          p="md"
          mb="xl"
          style={{
            background:
              'linear-gradient(135deg, var(--mantine-color-yellow-4), var(--mantine-color-orange-5))',
            borderColor: 'var(--mantine-color-orange-4)',
          }}
        >
          <Group justify="space-between" gap="md">
            <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 220 }}>
              <ThemeIcon size="xl" radius="xl" variant="white" color="orange">
                <IconGift size={22} />
              </ThemeIcon>
              <div>
                <Text fw={700} c="dark.8">
                  Gift cards available &mdash; pay with a credit card
                </Text>
                <Text size="sm" c="dark.7">
                  Buy Buzz or a Membership with any debit/credit card, no crypto required.
                </Text>
              </div>
            </Group>
            <Button
              component={NextLink}
              href="/gift-cards"
              color="dark"
              radius="md"
              rightSection={<IconArrowRight size={16} />}
            >
              Browse gift cards
            </Button>
          </Group>
        </Card>
      )}
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
      <BuzzPurchaseLayout
        buzzType={buzzType}
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
