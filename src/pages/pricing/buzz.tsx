import {
  Alert,
  Card,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import clsx from 'clsx';
import Router, { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { getBuzzMembershipPrice } from '~/shared/utils/buzz-membership';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzzMemberships) return { notFound: true };
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

const querySchema = z.object({
  tier: z.enum(['bronze', 'silver', 'gold']).optional(),
});

export default function BuzzMembershipPurchasePage() {
  const router = useRouter();
  const features = useFeatureFlags();
  const query = querySchema.safeParse(router.query);
  const initialTier = (query.success && query.data.tier) || undefined;

  // The site's currency: green on .com, yellow on .red. It's what gets debited and what
  // the colour-specific copy resolves off — the user doesn't choose, and the server
  // re-derives it from ctx.features rather than trusting anything sent from here. It does
  // NOT pick the catalog: one set of Buzz products serves both sites.
  const siteBuzzType: BuzzSpendType = features.isGreen ? 'green' : 'yellow';
  const [productId, setProductId] = useState<string | null>(null);

  // getAllUserSubscriptions, not useActiveSubscription: the latter looks up a single
  // buzzType slot (yellow by default) and would miss both referral grants and an
  // existing Buzz membership, which live in their own slots.
  const { data: subscriptions } = trpc.subscriptions.getAllUserSubscriptions.useQuery();
  const { data: products, isLoading } = trpc.subscriptions.getPlans.useQuery({
    interval: 'month',
    buzzPurchase: true,
    paymentProvider: 'Civitai',
  });

  useEffect(() => {
    if (productId || !products?.length) return;
    const preselected = initialTier
      ? products.find((p) => p.metadata.tier === initialTier)
      : undefined;
    setProductId((preselected ?? products[0]).id);
  }, [products, initialTier, productId]);

  const utils = trpc.useUtils();
  const purchaseMutation = trpc.subscriptions.purchaseWithBuzz.useMutation({
    onSuccess: async () => {
      await utils.subscriptions.invalidate();
      showSuccessNotification({
        title: 'Membership activated',
        message: 'Your perks are available now. Enjoy!',
      });
      Router.push('/user/membership');
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to purchase membership',
        error: new Error(error.message),
      });
    },
  });

  const selected = products?.find((p) => p.id === productId);
  const price =
    selected?.prices.find((p) => p.id === selected.defaultPriceId) ?? selected?.prices[0];
  const buzzAmount = price
    ? getBuzzMembershipPrice({
        unitAmount: price.unitAmount ?? 0,
        buzzPrice: selected?.metadata.buzzPrice,
      })
    : 0;
  const planDetails = selected ? getPlanDetails(selected, features, false) : undefined;
  const hasActiveMembership = (subscriptions ?? []).some(
    (s) => !s.isBadState && new Date(s.currentPeriodEnd) > new Date()
  );

  return (
    <>
      <Meta title="Purchase a Membership with Buzz | Civitai" deIndex />
      <Container size="sm" className="my-8">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={1} className="text-3xl font-bold">
              Purchase with Buzz
            </Title>
            <Text c="dimmed">
              Get one month of membership perks using the Buzz you&rsquo;ve earned. These
              memberships don&rsquo;t include monthly Buzz, bonus Buzz on purchases, or Creator
              Program access.
            </Text>
          </Stack>

          {hasActiveMembership && (
            <Alert color="yellow" icon={<IconInfoCircle size={20} />}>
              You already have a membership. You can purchase one with Buzz once it expires.
            </Alert>
          )}

          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : !products?.length ? (
            <Alert color="yellow" icon={<IconInfoCircle size={20} />}>
              There are no memberships available for purchase with Buzz right now.
            </Alert>
          ) : (
            <>
              <Stack gap="xs">
                <Text fw={600}>Choose a tier</Text>
                <Group grow align="stretch">
                  {products.map((product) => {
                    const productPrice =
                      product.prices.find((p) => p.id === product.defaultPriceId) ??
                      product.prices[0];
                    const amount = getBuzzMembershipPrice({
                      unitAmount: productPrice?.unitAmount ?? 0,
                      buzzPrice: product.metadata.buzzPrice,
                    });

                    return (
                      <UnstyledButton
                        key={product.id}
                        onClick={() => setProductId(product.id)}
                        className={clsx(
                          'rounded-lg border p-3 text-center',
                          product.id === productId
                            ? 'border-blue-5 bg-blue-9/10'
                            : 'border-gray-4 dark:border-dark-4'
                        )}
                      >
                        <Stack gap={4} align="center">
                          <Text fw={700}>{capitalize(product.metadata.tier)}</Text>
                          <Text size="sm" c="dimmed">
                            {numberWithCommas(amount)} Buzz / month
                          </Text>
                        </Stack>
                      </UnstyledButton>
                    );
                  })}
                </Group>
              </Stack>

              {selected && planDetails && (
                <Card withBorder p="lg">
                  <Stack gap="md">
                    <Group justify="space-between" align="center">
                      <Stack gap={0}>
                        <Text fw={700} size="lg">
                          {selected.name}
                        </Text>
                        <Text size="sm" c="dimmed">
                          1 month &middot; does not auto-renew
                        </Text>
                      </Stack>
                      {planDetails.image && (
                        <div className="w-16">
                          <EdgeMedia src={planDetails.image} className="size-full object-cover" />
                        </div>
                      )}
                    </Group>
                    <Divider />
                    <PlanBenefitList
                      benefits={planDetails.benefits}
                      tier={selected.metadata.tier}
                      buzzType={siteBuzzType}
                      creatorProgramDisabled
                    />
                  </Stack>
                </Card>
              )}

              <BuzzTransactionButton
                buzzAmount={buzzAmount}
                disabled={!selected || hasActiveMembership || buzzAmount <= 0}
                loading={purchaseMutation.isPending}
                label={
                  selected
                    ? `Purchase 1 month of ${capitalize(selected.metadata.tier)}`
                    : 'Purchase membership'
                }
                onPerformTransaction={() => {
                  if (!price) return;
                  purchaseMutation.mutate({ priceId: price.id });
                }}
                radius="xl"
                size="md"
              />

              <Text size="xs" c="dimmed" className="text-center">
                Memberships purchased with Buzz are sold one month at a time and never renew
                automatically.
              </Text>
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}
