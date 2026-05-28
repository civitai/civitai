import { Anchor, Button, Group, Card, Stack, Text } from '@mantine/core';
import { useThirdPartyConsent } from './consent.context';

export function ConsentBanner() {
  const { consent, accept, reject } = useThirdPartyConsent();
  if (consent !== null) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[201] p-3 sm:p-4">
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
