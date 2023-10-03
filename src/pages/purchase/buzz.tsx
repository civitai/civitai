import { Container, Stack, Title, Text, Alert, Group, Grid, Paper, List } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '@prisma/client';
import { BUZZ_FEATURE_LIST } from '~/server/common/constants';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { z } from 'zod';
import { parseNumericString } from '~/utils/query-string-helpers';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

const schema = z.object({
  returnUrl: z.string().optional(),
  minBuzzAmount: z.coerce.number().optional(),
});
export default function PurchaseBuzz() {
  const router = useRouter();
  const { returnUrl, minBuzzAmount } = schema.parse(router.query);
  const currentUser = useCurrentUser() ?? {};

  return (
    <Container size="md" mb="lg">
      <Alert radius="sm" color="yellow" style={{ zIndex: 10 }} mb="md">
        <Group spacing="xs" noWrap position="center">
          <CurrencyIcon currency={Currency.BUZZ} size={24} />
          <Title order={2}>Let&rsquo;s get me some BUZZ</Title>
        </Group>
      </Alert>
      <Grid gutter="sm">
        <Grid.Col xs={12} md={4}>
          <Stack>
            <Title order={2}>What can I do with Buzz?</Title>
            <List listStyleType="none" spacing="sm">
              {BUZZ_FEATURE_LIST.map((feature) => (
                <List.Item key={feature}>
                  <Group noWrap>
                    <CurrencyIcon style={{ flexShrink: 0 }} currency={Currency.BUZZ} size={18} />
                    <Text>{feature}</Text>
                  </Group>
                </List.Item>
              ))}
            </List>
          </Stack>
        </Grid.Col>
        <Grid.Col xs={12} md={8}></Grid.Col>
      </Grid>
    </Container>
  );
}
