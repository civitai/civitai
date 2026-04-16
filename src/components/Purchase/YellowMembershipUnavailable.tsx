import { Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { useServerDomains } from '~/providers/AppProvider';
import { QS } from '~/utils/qs';

export function YellowMembershipUnavailable() {
  const serverDomains = useServerDomains();
  const greenPricingUrl = `//${serverDomains.green}/pricing?${QS.stringify({
    buzzType: 'green',
    'sync-account': 'blue',
  })}`;

  return (
    <Stack gap="lg" style={{ maxWidth: 600, margin: '0 auto' }}>
      <Group gap="xs" wrap="nowrap" justify="center">
        <IconInfoCircle size={14} className="text-yellow-500" style={{ flexShrink: 0 }} />
        <Text size="xs" c="dimmed">
          Yellow memberships are no longer available.
        </Text>
      </Group>

      <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
        <Stack gap="md">
          <div className="flex items-center gap-2.5">
            <ThemeIcon size={36} radius="lg" color="yellow.6" variant="light">
              <IconBolt size={20} stroke={2} fill="currentColor" />
            </ThemeIcon>
            <div>
              <Text fw={600} size="md">
                Purchase Buzz
              </Text>
              <Text size="xs" c="dimmed">
                Power your generations and more
              </Text>
            </div>
          </div>
          <Text size="sm" c="dimmed">
            Buy Buzz to use across the site for image generation, video generation, model training,
            and other features. Supports all content ratings.
          </Text>
          <Button
            component={Link}
            href="/purchase/buzz"
            leftSection={<IconBolt size={16} fill="currentColor" />}
            color="yellow.7"
            radius="md"
            size="md"
          >
            Go to Buzz Purchase
          </Button>
        </Stack>
      </Paper>

      <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
        <Stack gap="md">
          <div className="flex items-center gap-2.5">
            <ThemeIcon size={36} radius="lg" color="green.6" variant="light">
              <IconBolt size={20} stroke={2} fill="currentColor" />
            </ThemeIcon>
            <div>
              <Text fw={600} size="md">
                Green Membership
              </Text>
              <Text size="xs" c="dimmed">
                Subscribe with standard payment methods
              </Text>
            </div>
          </div>
          <Text size="sm" c="dimmed">
            Get a membership with monthly Green Buzz delivery and membership perks. Green Buzz
            supports safe-for-work content creation. Pay with credit card through Stripe.
          </Text>
          <Button
            component="a"
            href={greenPricingUrl}
            target="_blank"
            rel="noreferrer"
            leftSection={<IconBolt size={16} fill="currentColor" />}
            color="green.7"
            radius="md"
            size="md"
          >
            View Green Memberships
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
