import { Button, Divider, Group, Paper, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconExternalLink, IconInfoCircle, IconX } from '@tabler/icons-react';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { trpc } from '~/utils/trpc';

type OnrampService = {
  name: string;
  description: string;
  tip?: string;
  url: string;
};

const regions: { value: string; label: string; services: OnrampService[] }[] = [
  {
    value: 'us',
    label: 'US',
    services: [
      {
        name: 'PayPal',
        description: 'Buy PYUSD in the PayPal app and send it to the address above.',
        url: 'https://www.paypal.com/myaccount/crypto',
      },
      {
        name: 'Cash App',
        description: 'Buy Bitcoin and send it directly from Cash App.',
        url: 'https://cash.app',
      },
      {
        name: 'Venmo',
        description: 'Buy crypto in Venmo, then send to this address.',
        url: 'https://venmo.com',
      },
      {
        name: 'Coinbase',
        description: 'Free USDC withdrawals on Base — the lowest fee option.',
        tip: 'Send USDC on Base for the lowest fees.',
        url: 'https://www.coinbase.com',
      },
    ],
  },
  {
    value: 'europe',
    label: 'Europe',
    services: [
      {
        name: 'Revolut',
        description: 'If you already have Revolut, crypto buying is built right into the app.',
        url: 'https://www.revolut.com',
      },
      {
        name: 'MoonPay',
        description:
          'Buy USDC directly to your wallet with a card — no exchange account needed.',
        url: 'https://www.moonpay.com',
      },
      {
        name: 'Kraken',
        description: 'Reputable exchange with low fees, licensed in multiple EU countries.',
        url: 'https://www.kraken.com',
      },
      {
        name: 'Coinbase',
        description: 'Free USDC withdrawals on Base — the lowest fee option.',
        tip: 'Send USDC on Base for the lowest fees.',
        url: 'https://www.coinbase.com',
      },
    ],
  },
  {
    value: 'asia',
    label: 'Asia',
    services: [
      {
        name: 'Binance',
        description:
          'Dominant across Southeast Asia with USDC on Base support and local currency P2P.',
        tip: 'Send USDC on Base for the lowest fees.',
        url: 'https://www.binance.com',
      },
      {
        name: 'OKX',
        description:
          'Licensed in Singapore and Dubai, great mobile app with a built-in Web3 wallet.',
        url: 'https://www.okx.com',
      },
      {
        name: 'Bybit',
        description:
          'Popular across Asia with 15 language support and a $2 minimum purchase.',
        url: 'https://www.bybit.com',
      },
      {
        name: 'MoonPay',
        description:
          'Buy USDC with a card and have it sent directly to your wallet — no exchange needed.',
        url: 'https://www.moonpay.com',
      },
    ],
  },
  {
    value: 'latam',
    label: 'Latin America',
    services: [
      {
        name: 'Binance',
        description:
          'Universal across Latin America with P2P trading for local currencies.',
        tip: 'Send USDC on Base for the lowest fees.',
        url: 'https://www.binance.com',
      },
      {
        name: 'Bitso',
        description:
          'Largest Latin American exchange — supports MXN, BRL, ARS, and COP.',
        url: 'https://www.bitso.com',
      },
      {
        name: 'MoonPay',
        description:
          'Buy USDC with a card in one step — works across most Latin American countries.',
        url: 'https://www.moonpay.com',
      },
    ],
  },
  {
    value: 'other',
    label: 'Other',
    services: [
      {
        name: 'MoonPay',
        description:
          'Available in 160+ countries. Buy crypto with a card, Apple Pay, or Google Pay — sent directly to your wallet.',
        tip: 'Easiest option if you don\u2019t want to create an exchange account.',
        url: 'https://www.moonpay.com',
      },
      {
        name: 'Transak',
        description:
          'Available in 150+ countries. Integrates with Trust Wallet and MetaMask for in-wallet purchases.',
        url: 'https://www.transak.com',
      },
      {
        name: 'Binance',
        description:
          'Available in 180+ countries with P2P trading for local currencies.',
        url: 'https://www.binance.com',
      },
    ],
  },
];

const ALERT_ID = 'crypto-onramp-guidance';

export function useOnrampDismissed() {
  const settings = useCurrentUserSettings();
  return (settings.dismissedAlerts ?? []).includes(ALERT_ID);
}

export function OnrampGuidance() {
  const isDismissed = useOnrampDismissed();
  const utils = trpc.useUtils();
  const dismissMutation = trpc.user.dismissAlert.useMutation({
    onMutate: async () => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: [...(old?.dismissedAlerts ?? []), ALERT_ID],
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
    onSettled: () => utils.user.getSettings.invalidate(),
  });

  if (isDismissed) return null;

  return (
    <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconInfoCircle size={20} className="text-blue-500" />
          <Title order={5}>New to crypto?</Title>
        </Group>
        <Button
          variant="subtle"
          size="xs"
          color="gray"
          onClick={() => dismissMutation.mutate({ alertId: ALERT_ID })}
          leftSection={<IconX size={14} />}
        >
          Dismiss
        </Button>
      </Group>
      <Stack gap="sm">
          <Text size="sm" c="dimmed">
            You&rsquo;ll need a crypto app to buy and send crypto to Civitai. Pick your region
            below for the easiest options. For the lowest fees, send{' '}
            <Text span fw={600}>
              USDC on the Base network
            </Text>
            .
          </Text>
          <Tabs defaultValue="us" variant="pills">
            <Tabs.List mb="sm">
              {regions.map((r) => (
                <Tabs.Tab key={r.value} value={r.value} size="xs">
                  {r.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {regions.map((region) => (
              <Tabs.Panel key={region.value} value={region.value}>
                <Paper
                  radius="sm"
                  withBorder
                  className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
                >
                  {region.services.map((service, i) => (
                    <div key={service.name}>
                      {i > 0 && <Divider />}
                      <Group
                        gap="sm"
                        p="sm"
                        wrap="nowrap"
                        justify="space-between"
                        align="flex-start"
                      >
                        <Stack gap={2} style={{ flex: 1 }}>
                          <Text size="sm" fw={600}>
                            {service.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {service.description}
                          </Text>
                          {service.tip && (
                            <Text size="xs" c="green" fw={500}>
                              {service.tip}
                            </Text>
                          )}
                        </Stack>
                        <Button
                          component="a"
                          href={service.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="subtle"
                          size="xs"
                          color="gray"
                          rightSection={<IconExternalLink size={12} />}
                          style={{ flexShrink: 0 }}
                        >
                          Visit
                        </Button>
                      </Group>
                    </div>
                  ))}
                </Paper>
              </Tabs.Panel>
            ))}
          </Tabs>
          <Text size="xs" c="dimmed">
            Copy your deposit address above (or scan the QR code on mobile), buy crypto in any of
            these apps, and send it to that address. Your Buzz will appear automatically.
          </Text>
          <Text size="xs" c="dimmed">
            <Text span fw={600} c="dimmed">
              Tip:
            </Text>{' '}
            For the lowest fees, send USDC on Base. Sending Bitcoin or Ethereum may include
            $0.50–$2.00 in network fees.
          </Text>
        </Stack>
    </Paper>
  );
}

/** Small toggle to re-show the guidance card after it's been dismissed. Place at page bottom. */
export function OnrampGuidanceToggle() {
  const isDismissed = useOnrampDismissed();
  const utils = trpc.useUtils();
  const restoreMutation = trpc.user.dismissAlert.useMutation({
    onMutate: async () => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: (old?.dismissedAlerts ?? []).filter((id: string) => id !== ALERT_ID),
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
    onSettled: () => utils.user.getSettings.invalidate(),
  });

  if (!isDismissed) return null;

  const handleRestore = () => {
    restoreMutation.mutate({ alertId: ALERT_ID, dismiss: false });
  };

  return (
    <Button
      variant="subtle"
      size="xs"
      color="dimmed"
      onClick={handleRestore}
      leftSection={<IconInfoCircle size={14} />}
    >
      New to crypto? Show guide
    </Button>
  );
}
