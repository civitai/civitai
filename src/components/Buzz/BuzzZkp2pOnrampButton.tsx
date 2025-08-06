import { Button, Stack, Title, Text, Divider, List } from '@mantine/core';
import {
  IconCreditCard,
  IconChevronRight,
  IconCheck,
  IconMobiledata,
  IconDeviceDesktop,
  IconExclamationMark,
} from '@tabler/icons-react';
import type { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useMutateZkp2p } from '~/components/ZKP2P/util';

// Browser detection utility
const isSupportedBrowser = () => {
  if (typeof window === 'undefined') return true; // SSR safe

  const userAgent = window.navigator.userAgent.toLowerCase();
  return (
    (userAgent.includes('chrome') || userAgent.includes('edge') || userAgent.includes('brave')) &&
    !userAgent.includes('mobile')
  );
};

export const BuzzZkp2pOnrampButton = ({
  unitAmount,
  buzzAmount,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}) => {
  const { createBuzzOrderOnramp, creatingBuzzOrderOnramp } = useMutateZkp2p();
  const isUnsupportedBrowser = !isSupportedBrowser();

  const handleClick = async () => {
    // Show browser compatibility warning for unsupported browsers
    if (isUnsupportedBrowser) {
      dialogStore.trigger({
        component: AlertDialog,
        props: {
          title: '🌐 Browser Compatibility Required',
          type: 'warning',
          icon: null,
          children: ({ handleClose }) => (
            <div className="space-y-4">
              <Text>ZKP2P requires a supported desktop browser to work properly.</Text>

              <div className="space-y-2">
                <Text fw={500}>Supported browsers:</Text>
                <List size="sm" spacing="xs">
                  <List.Item>Google Chrome (desktop)</List.Item>
                  <List.Item>Microsoft Edge (desktop)</List.Item>
                  <List.Item>Brave Browser (desktop)</List.Item>
                </List>
              </div>

              <Text size="sm" c="dimmed">
                Please switch to one of these browsers and try again. Mobile browsers are not
                currently supported.
              </Text>

              <Button onClick={handleClose} fullWidth>
                Got it
              </Button>
            </div>
          ),
        },
      });

      return;
    }
    const data = await createBuzzOrderOnramp({
      unitAmount,
      buzzAmount,
    });

    if (data?.url) {
      dialogStore.trigger({
        component: AlertDialog,
        props: {
          title: '🔐 Buy Buzz with Your Favorite Payment App',
          type: 'info',
          icon: null,
          size: 'lg',
          children: ({ handleClose }) => (
            <div className="flex w-full max-h-[70vh] flex-col gap-6 overflow-y-auto">
              <div className="space-y-4">
                <Text fw={500} size="lg">
                  Safe, direct payments through apps you already use
                </Text>

                <Button
                  variant="light"
                  color="blue"
                  size="sm"
                  leftSection={<IconMobiledata size={16} />}
                  fullWidth
                >
                  Watch How It Works - 2 min video
                </Button>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  💡 What is This?
                </Title>
                <Text size="sm" fw={500}>
                  A New Way to Buy Buzz
                </Text>
                <Text size="sm" c="dimmed">
                  Using ZKP2P (a secure exchange platform), you send money through your payment app
                  to another user who has digital dollars waiting in a secure vault for you. Once
                  your payment is verified, their digital dollars automatically release to you and
                  convert to Buzz.
                </Text>

                <div className="space-y-2">
                  <Text size="sm" fw={500}>
                    Why this way?
                  </Text>
                  <List size="sm" spacing="xs">
                    <List.Item icon={<IconCheck size={14} color="green" />}>
                      Use payment apps you already trust
                    </List.Item>
                    <List.Item icon={<IconCheck size={14} color="green" />}>
                      No credit card fees
                    </List.Item>
                    <List.Item icon={<IconCheck size={14} color="green" />}>
                      Protected transactions
                    </List.Item>
                    <List.Item icon={<IconCheck size={14} color="green" />}>
                      We can&apos;t accept cards directly
                    </List.Item>
                  </List>
                </div>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  📱 How It Works
                </Title>
                <Text size="sm" fw={500}>
                  Simple 3-Step Process
                </Text>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <Text size="sm" fw={500}>
                      Step 1: Send Payment
                    </Text>
                    <Text size="sm" c="dimmed">
                      Send money through your payment app to the matched user
                    </Text>
                  </div>
                  <div className="space-y-1">
                    <Text size="sm" fw={500}>
                      Step 2: Verify with ZKP2P
                    </Text>
                    <Text size="sm" c="dimmed">
                      The ZKP2P system confirms your payment and releases the vaulted funds
                    </Text>
                  </div>
                  <div className="space-y-1">
                    <Text size="sm" fw={500}>
                      Step 3: Get Your Buzz
                    </Text>
                    <Text size="sm" c="dimmed">
                      Digital dollars arrive and instantly convert to Buzz
                    </Text>
                  </div>
                </div>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  🛡️ Is This Safe?
                </Title>
                <Text size="sm" fw={500}>
                  Yes, Here&apos;s Why
                </Text>
                <List size="sm" spacing="xs">
                  <List.Item>
                    Digital dollars are already locked in a secure vault before you pay
                  </List.Item>
                  <List.Item>
                    Once you prove payment, the funds automatically release to you
                  </List.Item>
                  <List.Item>Over $10M+ safely processed through ZKP2P</List.Item>
                </List>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  Requirements
                </Title>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <IconDeviceDesktop size={16} />
                    <Text size="sm" fw={500}>
                      Desktop browser
                    </Text>
                    <span className="rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
                      Chrome, Edge, Brave
                    </span>
                  </div>
                  <div className="space-y-1">
                    <Text size="sm" fw={500}>
                      Supported Apps:
                    </Text>
                    <Text size="sm" c="dimmed">
                      Venmo • CashApp • Zelle (Chase/BofA/Citi) • PayPal (Personal Account) • Wise •
                      Revolut
                    </Text>
                  </div>
                </div>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  Quick Steps
                </Title>
                <List size="sm" spacing="xs" type="ordered">
                  <List.Item>
                    <Text component="span" fw={500}>
                      Send Payment
                    </Text>{' '}
                    → Use exact amount shown in your payment app
                  </List.Item>
                  <List.Item>
                    <Text component="span" fw={500}>
                      Install Verification Extension
                    </Text>{' '}
                    → One-time 30-second setup
                  </List.Item>
                  <List.Item>
                    <Text component="span" fw={500}>
                      Verify & Done
                    </Text>{' '}
                    → Click verify, get Buzz in 1-2 minutes 🎉
                  </List.Item>
                </List>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  Important
                </Title>
                <List size="sm" spacing="xs">
                  <List.Item>
                    <Text component="span" fw={500}>
                      No refunds through Civitai
                    </Text>{' '}
                    - You&apos;re trading directly with another user
                  </List.Item>
                  <List.Item>
                    <Text component="span" fw={500}>
                      Send exact amounts
                    </Text>{' '}
                    - Match the amount and currency shown
                  </List.Item>
                  <List.Item>
                    <Text component="span" fw={500}>
                      Desktop only
                    </Text>{' '}
                    for now (mobile coming soon)
                  </List.Item>
                </List>
              </div>

              <Divider />

              <div className="space-y-4">
                <Title order={3} size="h4">
                  Ready to Start?
                </Title>
                <div className="flex flex-col gap-3">
                  <Button
                    onClick={() => {
                      window.location.replace(data.url);
                    }}
                    size="md"
                    radius="md"
                    rightSection={<IconChevronRight size={16} />}
                    fullWidth
                  >
                    Continue to Payment
                  </Button>
                  <Button size="md" radius="md" variant="light" onClick={handleClose} fullWidth>
                    Cancel
                  </Button>
                </div>

                <Text size="xs" c="dimmed" ta="center">
                  By continuing, you acknowledge that you&apos;re exchanging currency with another
                  individual on ZKP2P and that Civitai cannot process refunds for these
                  transactions.
                </Text>
              </div>
            </div>
          ),
        },
      });
    }
  };

  return (
    <Stack gap={0} align="center">
      <Button
        disabled={disabled || isUnsupportedBrowser}
        loading={creatingBuzzOrderOnramp}
        onClick={handleClick}
        size="md"
        radius="md"
        variant="light"
        color={isUnsupportedBrowser ? 'gray' : 'yellow'}
        leftSection={<IconCreditCard size={16} />}
        fw={500}
        fullWidth
      >
        {isUnsupportedBrowser ? 'ZKP2P (Chrome/Edge/Brave Required)' : 'ZKP2P (Private USDC)'}
      </Button>
    </Stack>
  );
};
