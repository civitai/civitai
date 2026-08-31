import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconGift, IconInfoCircle } from '@tabler/icons-react';
import clsx from 'clsx';
import Router, { useRouter } from 'next/router';
import { useState } from 'react';
import * as z from 'zod';
import { MembershipGiftsCard } from '~/components/Account/MembershipGiftsCard';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GiftableTier } from '~/server/schema/membership-gift.schema';
import { giftableTierSchema, giftMonthsOptions } from '~/server/schema/membership-gift.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { capitalize, getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.giftMemberships) return { notFound: true };
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
  userId: z.coerce.number().int().positive().optional(),
  tier: giftableTierSchema.optional(),
});

type GiftRecipient = { id: number; username: string | null };
type GiftMonths = (typeof giftMonthsOptions)[number];

const blockedReasons: Record<string, string> = {
  'annual-interval':
    'This user is on an annual membership, which cannot receive gifted months yet.',
  'billing-issue': "This user's membership has a billing issue and cannot receive gifts right now.",
  'unsupported-provider': "This user's membership cannot receive gifted months.",
};

export default function GiftMembershipPage() {
  const router = useRouter();
  const features = useFeatureFlags();
  const query = querySchema.safeParse(router.query);
  const initialUserId = query.success ? query.data.userId : undefined;
  const initialTier = (query.success && query.data.tier) || 'gold';

  const [recipient, setRecipient] = useState<GiftRecipient | null>(
    initialUserId ? { id: initialUserId, username: null } : null
  );
  const [tier, setTier] = useState<GiftableTier>(initialTier);
  const [months, setMonths] = useState<GiftMonths>(3);
  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(false);

  // Same query key CreatorCardV2 uses internally, so this is a cache hit
  const { data: recipientCreator } = trpc.user.getCreator.useQuery(
    { id: recipient?.id as number },
    { enabled: !!recipient }
  );
  const recipientUsername = recipient?.username ?? recipientCreator?.username ?? null;

  const { data: giftability, isLoading: giftabilityLoading } =
    trpc.membershipGift.getRecipientGiftability.useQuery(
      { recipientUserId: recipient?.id as number },
      { enabled: !!recipient }
    );

  const { data: plans, isLoading: plansLoading } = trpc.subscriptions.getPlans.useQuery({
    interval: 'month',
    paymentProvider: 'Stripe',
  });

  const createCheckout = trpc.membershipGift.createCheckout.useMutation({
    onSuccess: ({ url }) => {
      if (url) Router.push(url);
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not start gift checkout',
        error: new Error(error.message),
      }),
  });

  const lockedTier = giftability?.status === 'active' ? giftability.tier : null;
  const effectiveTier = lockedTier ?? tier;
  const blocked = giftability?.status === 'blocked';

  const tierPlans = (plans ?? []).filter((p) =>
    ['bronze', 'silver', 'gold'].includes(p.metadata.tier)
  );
  const selectedPlan = tierPlans.find((p) => p.metadata.tier === effectiveTier);
  const selectedPlanDetails = selectedPlan ? getPlanDetails(selectedPlan, features) : null;
  const monthlyDisplay = selectedPlan
    ? getStripeCurrencyDisplay(selectedPlan.price.unitAmount, selectedPlan.price.currency)
    : null;
  const totalDisplay = selectedPlan
    ? getStripeCurrencyDisplay(selectedPlan.price.unitAmount * months, selectedPlan.price.currency)
    : null;

  const canSubmit = !!recipient && !blocked && !giftabilityLoading && !!selectedPlan;

  const handleSubmit = () => {
    if (!recipient) return;
    createCheckout.mutate({
      recipientUserId: recipient.id,
      tier: effectiveTier,
      months,
      message: message.trim() ? message.trim() : undefined,
      anonymous,
    });
  };

  return (
    <>
      <Meta title="Gift a Membership | Civitai" deIndex />
      <Container size="lg" py="xl">
        <Stack gap="xl">
          <Stack gap={4} align="center">
            <Group gap="xs">
              <IconGift size={32} className="text-blue-4" />
              <Title order={1}>Gift a Membership</Title>
            </Group>
            <Text c="dimmed" ta="center" maw={520}>
              Treat someone to Civitai membership perks — monthly Buzz, more generation power, and
              everything their tier includes. They never pay a thing.
            </Text>
          </Stack>

          <Grid gutter="xl">
            <Grid.Col span={{ base: 12, md: 7 }}>
              <Stack gap="lg">
                <Stack gap="xs">
                  <Title order={4}>1. Who is it for?</Title>
                  {recipient ? (
                    <Stack gap={4} w={450} maw="100%" mx="auto">
                      <CreatorCardV2 user={recipient} withActions={false} tipsEnabled={false} />
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        className="self-end"
                        onClick={() => setRecipient(null)}
                      >
                        Change recipient
                      </Button>
                    </Stack>
                  ) : (
                    <QuickSearchDropdown
                      disableInitialSearch
                      supportedIndexes={['users']}
                      startingIndex="users"
                      showIndexSelect={false}
                      dropdownItemLimit={25}
                      placeholder="Search for a user"
                      onItemSelected={(_entity, item) => {
                        const user = item as { id: number; username: string | null };
                        setRecipient({ id: user.id, username: user.username });
                      }}
                      clearable
                    />
                  )}
                  {recipient && giftabilityLoading && (
                    <Group gap="xs">
                      <Loader size="xs" />
                      <Text size="sm" c="dimmed">
                        Checking their membership…
                      </Text>
                    </Group>
                  )}
                  {recipient && giftability?.status === 'no-subscription' && (
                    <Alert color="teal" icon={<IconGift size={18} />}>
                      They don&rsquo;t have an active membership yet — your gift starts a{' '}
                      {capitalize(effectiveTier)} membership for them the moment it&rsquo;s paid.
                      Nothing needed on their end.
                    </Alert>
                  )}
                  {recipient && giftability?.status === 'active' && (
                    <Alert color="blue" icon={<IconInfoCircle size={18} />}>
                      They&rsquo;re already on {capitalize(giftability.tier)}
                      {giftability.renewsAt
                        ? ` (renews ${formatDate(giftability.renewsAt)})`
                        : ''}{' '}
                      — your gift adds free months on top of their existing membership, so the tier
                      is locked to match theirs.
                      {giftability.cancelsAtPeriodEnd &&
                        ' Their membership is set to cancel; the free months are added before it ends, and billing will not restart unless they choose to keep it.'}
                    </Alert>
                  )}
                  {blocked && giftability && (
                    <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
                      {blockedReasons[giftability.reason] ??
                        'This user cannot receive gifted months.'}
                    </Alert>
                  )}
                </Stack>

                <Stack gap="xs">
                  <Title order={4}>2. Pick a tier</Title>
                  {plansLoading ? (
                    <Center py="lg">
                      <Loader />
                    </Center>
                  ) : (
                    <Group grow align="stretch">
                      {tierPlans.map((plan) => {
                        const planTier = plan.metadata.tier as GiftableTier;
                        const { image } = getPlanDetails(plan, features);
                        const isSelected = planTier === effectiveTier;
                        const isDisabled = blocked || (!!lockedTier && lockedTier !== planTier);
                        return (
                          <UnstyledButton
                            key={plan.id}
                            disabled={isDisabled}
                            onClick={() => setTier(planTier)}
                            className={clsx(
                              'rounded-lg border-2 p-4 transition-colors',
                              isSelected
                                ? 'border-blue-5 bg-blue-5/10'
                                : 'border-gray-3 dark:border-dark-4',
                              isDisabled && 'opacity-40'
                            )}
                          >
                            <Stack gap={4} align="center">
                              {image && (
                                <Box w={56}>
                                  <EdgeMedia src={image} className="size-full object-cover" />
                                </Box>
                              )}
                              <Text fw={600}>{capitalize(planTier)}</Text>
                              <Text size="sm" c="dimmed">
                                {getStripeCurrencyDisplay(
                                  plan.price.unitAmount,
                                  plan.price.currency
                                )}
                                /mo
                              </Text>
                            </Stack>
                          </UnstyledButton>
                        );
                      })}
                    </Group>
                  )}
                  {selectedPlanDetails?.benefits && (
                    <Paper className="rounded-md bg-gray-0 p-5 dark:bg-dark-8" withBorder>
                      <PlanBenefitList
                        benefits={selectedPlanDetails.benefits}
                        tier={effectiveTier}
                        buzzType={selectedPlan?.metadata.buzzType}
                      />
                    </Paper>
                  )}
                </Stack>

                <Stack gap="xs">
                  <Title order={4}>3. How many months?</Title>
                  <SegmentedControl
                    size="md"
                    value={String(months)}
                    onChange={(value) => setMonths(Number(value) as GiftMonths)}
                    disabled={blocked}
                    data={giftMonthsOptions.map((m) => ({
                      value: String(m),
                      label: `${m} month${m === 1 ? '' : 's'}`,
                    }))}
                  />
                </Stack>

                <Stack gap="xs">
                  <Title order={4}>4. Add a personal touch</Title>
                  <Textarea
                    placeholder="Enjoy the membership!"
                    maxLength={500}
                    autosize
                    minRows={2}
                    value={message}
                    onChange={(e) => setMessage(e.currentTarget.value)}
                  />
                  <Switch
                    label="Gift anonymously"
                    description="Your username won't be shown to the recipient"
                    checked={anonymous}
                    onChange={(e) => setAnonymous(e.currentTarget.checked)}
                  />
                </Stack>
              </Stack>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 5 }}>
              <Stack className="sticky top-4">
                <Card withBorder radius="md" p="lg">
                  <Stack>
                    <Title order={4}>Gift summary</Title>
                    <Divider />
                    <Group justify="space-between">
                      <Text c="dimmed">Recipient</Text>
                      <Text fw={500}>
                        {recipientUsername
                          ? `@${recipientUsername}`
                          : recipient
                          ? '…'
                          : 'Not selected'}
                      </Text>
                    </Group>
                    <Group justify="space-between">
                      <Text c="dimmed">Membership</Text>
                      <Group gap={6}>
                        <Text fw={500}>{capitalize(effectiveTier)}</Text>
                        {lockedTier && (
                          <Badge size="xs" variant="light">
                            matches theirs
                          </Badge>
                        )}
                      </Group>
                    </Group>
                    <Group justify="space-between">
                      <Text c="dimmed">Duration</Text>
                      <Text fw={500}>
                        {months} month{months === 1 ? '' : 's'}
                      </Text>
                    </Group>
                    {monthlyDisplay && (
                      <Group justify="space-between">
                        <Text c="dimmed">Price</Text>
                        <Text fw={500}>
                          {monthlyDisplay}/mo × {months}
                        </Text>
                      </Group>
                    )}
                    <Divider />
                    <Group justify="space-between">
                      <Text fw={600} size="lg">
                        Total
                      </Text>
                      <Text fw={700} size="lg">
                        {totalDisplay ?? '—'}
                      </Text>
                    </Group>
                    <Button
                      size="lg"
                      radius="xl"
                      leftSection={<IconGift size={20} />}
                      disabled={!canSubmit}
                      loading={createCheckout.isPending}
                      onClick={handleSubmit}
                    >
                      Continue to payment
                    </Button>
                    <Text size="xs" c="dimmed">
                      One-time payment via Stripe. If they already have a membership, your gift adds
                      free months to it; otherwise a membership starts for them right away — no
                      payment details needed on their end.
                    </Text>
                  </Stack>
                </Card>
                <MembershipGiftsCard compact showGiftAction={false} />
              </Stack>
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </>
  );
}
