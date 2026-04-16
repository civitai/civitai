import { Anchor, Button, Card, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconCreditCard, IconDiamond } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useServerDomains } from '~/providers/AppProvider';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { formatRewardsBoost, getAccountTypeLabel } from '~/utils/buzz';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { syncAccount } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';

/**
 * Shown on non-green buzz purchase flows (where crypto is the only option)
 * to redirect users uncomfortable with crypto to civitai.green where they can
 * pay with card — either for Green Buzz direct or a membership.
 */
export function NoCryptoUpsell() {
  const currentUser = useCurrentUser();
  const serverDomains = useServerDomains();

  const { data: products = [] } = trpc.subscriptions.getPlans.useQuery(
    { paymentProvider: PaymentProvider.Stripe },
    { enabled: !!currentUser }
  );

  // Lead with Bronze — lowest price of entry, best conversion hook.
  const bronze = products.find(
    (p) => (p.metadata as SubscriptionProductMetadata)?.tier === 'bronze'
  );
  const headlinePlan = bronze ?? products[0];

  const greenDomain = serverDomains.green;
  const greenBuzzUrl = syncAccount(`//${greenDomain}/purchase/buzz`);
  const greenPricingUrl = syncAccount(`//${greenDomain}/pricing`);

  if (!headlinePlan) {
    // Fall back to a simpler version when plan data hasn't loaded.
    return (
      <Card padding="md" radius="md" withBorder>
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={36} radius="xl" variant="light" color="grape">
              <IconCreditCard size={20} />
            </ThemeIcon>
            <div>
              <Text size="sm" fw={700}>
                Prefer to pay with a card?
              </Text>
              <Text size="xs" c="dimmed">
                Buy Green Buzz or grab a membership on {greenDomain}.
              </Text>
            </div>
          </Group>
          <Group gap="xs" wrap="wrap">
            <Button
              component="a"
              href={greenBuzzUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              color="green"
              size="compact-sm"
              radius="xl"
              rightSection={<IconArrowRight size={14} />}
            >
              Buy Green Buzz
            </Button>
            <Button
              component="a"
              href={greenPricingUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              color="grape"
              size="compact-sm"
              radius="xl"
              rightSection={<IconArrowRight size={14} />}
            >
              Memberships
            </Button>
          </Group>
        </Stack>
      </Card>
    );
  }

  const meta = (headlinePlan.metadata ?? {}) as SubscriptionProductMetadata;
  const tier = meta.tier ?? 'silver';
  const monthlyBuzz = Number(meta.monthlyBuzz ?? 0);
  const rewardsMultiplier = Number(meta.rewardsMultiplier ?? 1);
  const purchasesMultiplier = Number(meta.purchasesMultiplier ?? 1);
  const buzzLabel = meta.buzzType ? `${getAccountTypeLabel(meta.buzzType)} Buzz` : 'Buzz';
  const price = headlinePlan.price.unitAmount ?? 0;

  const perkBits: string[] = [];
  if (monthlyBuzz > 0) perkBits.push(`${numberWithCommas(monthlyBuzz)} ${buzzLabel}/mo`);
  if (rewardsMultiplier > 1) perkBits.push(`${formatRewardsBoost(rewardsMultiplier)} rewards`);
  if (purchasesMultiplier > 1) {
    const pct = Math.round((purchasesMultiplier - 1) * 100);
    perkBits.push(`+${pct}% on purchases`);
  }
  perkBits.push('high-priority generation');
  perkBits.push('exclusive cosmetics');

  return (
    <Card padding="md" radius="md" withBorder>
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon size={36} radius="xl" variant="light" color="grape" className="shrink-0">
            <IconCreditCard size={20} />
          </ThemeIcon>
          <Stack gap={2}>
            <Text size="sm" fw={700}>
              Prefer to pay with a card?
            </Text>
            <Text size="xs" c="dimmed">
              Grab {capitalize(tier)} or buy Green Buzz direct on{' '}
              <Text span fw={600}>
                {greenDomain}
              </Text>
              .
            </Text>
          </Stack>
        </Group>

        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon size={36} radius="xl" variant="light" color="grape" className="shrink-0">
            <IconDiamond size={20} />
          </ThemeIcon>
          <Stack gap={2}>
            <Text size="xs" fw={700}>
              {capitalize(tier)} Membership · $
              {formatPriceForDisplay(price, undefined, { decimals: false })}/mo
            </Text>
            <Text size="xs" c="dimmed">
              {perkBits.join(', ')}
            </Text>
          </Stack>
        </Group>

        <Group gap="xs" wrap="wrap">
          <Button
            component="a"
            href={greenPricingUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="light"
            color="grape"
            size="compact-sm"
            radius="xl"
            rightSection={<IconArrowRight size={14} />}
          >
            Get {capitalize(tier)}
          </Button>
          <Anchor
            href={greenBuzzUrl}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            fw={600}
            c="green.4"
            className="inline-flex items-center gap-1"
          >
            Or buy Green Buzz <IconArrowRight size={12} />
          </Anchor>
        </Group>
        <Group gap={6} wrap="nowrap" align="center">
          <IconAlertTriangle size={14} className="text-yellow-500 shrink-0" />
          <Text size="xs" c="dimmed">
            Green Buzz only works for SFW content.
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
