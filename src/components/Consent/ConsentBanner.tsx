import { Anchor, Button, Group, Card, Stack, Text } from '@mantine/core';
import { useThirdPartyConsent } from './consent.context';

export function ConsentBanner() {
  const { consent, accept, reject } = useThirdPartyConsent();
  if (consent !== null) return null;

  return (
    // `max(…)` rather than a bare inset: the existing 12/16px is the design
    // padding on every device, and the inset only has to win where it is larger
    // than that. Adding the two would double-pad on a notched phone.
    //
    // `inset-x-0` means this box spans the full width, so in landscape the
    // ~47px left/right cutout strips are inside it and the 12/16px padding does
    // not clear them — the Accept/Reject buttons are the things at those ends.
    <div className="fixed inset-x-0 bottom-0 z-[201] p-3 pb-[max(0.75rem,var(--safe-area-inset-bottom))] pl-[max(0.75rem,var(--safe-area-inset-left))] pr-[max(0.75rem,var(--safe-area-inset-right))] sm:p-4 sm:pb-[max(1rem,var(--safe-area-inset-bottom))] sm:pl-[max(1rem,var(--safe-area-inset-left))] sm:pr-[max(1rem,var(--safe-area-inset-right))]">
      <Card p="md" shadow="lg" radius="md" withBorder className="mx-auto max-w-3xl">
        <Stack gap="sm">
          <Stack gap={4}>
            <Text fw={600} size="sm">
              Your privacy choices
            </Text>
            <Text size="xs" c="dimmed">
              We use cookies for analytics and advertising. Under California law, we need your
              consent before loading these. Essential cookies (login, payments, security) stay on
              either way. See our{' '}
              <Anchor href="/content/privacy" inherit>
                Privacy Policy
              </Anchor>{' '}
              for details.
            </Text>
          </Stack>
          <Group gap="xs" justify="flex-end">
            <Button variant="default" size="xs" onClick={reject}>
              Reject
            </Button>
            <Button size="xs" onClick={accept}>
              Accept
            </Button>
          </Group>
        </Stack>
      </Card>
    </div>
  );
}
