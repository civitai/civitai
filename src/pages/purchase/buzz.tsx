import {
  Container,
  Stack,
  Title,
  Text,
  Alert,
  Group,
  List,
  Center,
  Divider,
  ListProps,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '@prisma/client';
import { BUZZ_FEATURE_LIST } from '~/server/common/constants';
import { z } from 'zod';
import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase';
import { enterFall, jelloVertical } from '~/libs/animations';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import React, { useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';

const schema = z.object({
  returnUrl: z.string().optional(),
  minBuzzAmount: z.coerce.number().optional(),
});

const BuzzFeatures = (props: Omit<ListProps, 'children'>) => {
  return (
    <List listStyleType="none" spacing="sm" {...props}>
      {BUZZ_FEATURE_LIST.map((feature) => (
        <List.Item key={feature}>
          <Group noWrap>
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
            // animation: `${jelloVerical} 2s 1s ease-in-out`,
            animationName: `${enterFall}, ${jelloVertical}`,
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
          Your BUZZ has been added to your account and you&rsquo;re ready to start using it!
        </Text>
        <Divider my="md" />
        <Center>
          <Stack>
            <Title order={3} align="center">
              Where to go from here?
            </Title>
            <BuzzFeatures />
          </Stack>
        </Center>
      </Container>
    );
  }

  return (
    <Container size="md" mb="lg">
      <Alert radius="sm" color="yellow" style={{ zIndex: 10 }} mb="xl">
        <Group spacing="xs" noWrap position="center">
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
