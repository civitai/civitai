import { Box, Button, Group, Stack, Text } from '@mantine/core';
import { IconPlayerPause } from '@tabler/icons-react';
import NextLink from 'next/link';
import { formatWhen } from '~/components/Account/usage/usage-limit-view';
import type { MyAppBuzzCap } from '~/server/services/blocks/app-buzz-usage.service';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * The running app's "paused at your plan's daily Buzz limit" notice, drawn by the page host
 * OUTSIDE the iframe (an app cannot hide it or click it), between the chrome and the app. It
 * offers the upgrade, and — where the viewer's plan has a higher ceiling to continue to — the
 * opt-in to continue on their own Buzz for the rest of the UTC day.
 *
 * Mounted only behind the `appLimitsUpgradePrompt` flag; the server answers `null` with the
 * flag off too. Read once when the app opens and again after any generation the server refuses,
 * never per call. Opting in is the viewer's own session (`user.optInAppBuzzToday`), which an app
 * holding only its block token cannot make.
 */
export function AppBuzzCapNoticeView({
  data,
  now,
  optingIn,
  onOptIn,
}: {
  data?: MyAppBuzzCap | null;
  now: number;
  optingIn?: boolean;
  onOptIn: () => void;
}) {
  if (!data || !data.paused) return null;
  const resumes = formatWhen(Date.parse(data.resetAt), now);
  return (
    <Box
      role="status"
      data-testid="app-buzz-cap-paused"
      px="md"
      py="xs"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Group justify="space-between" wrap="wrap" gap="sm" align="center">
        <Group gap="xs" wrap="nowrap" className="min-w-0">
          <IconPlayerPause size={16} className="shrink-0" color="var(--mantine-color-yellow-6)" />
          <Stack gap={0} className="min-w-0">
            <Text size="sm" fw={600}>
              {data.optedIn
                ? `You've reached today's limit of ${numberWithCommas(
                    data.limit
                  )} Buzz across apps.`
                : `You've reached your plan's daily limit of ${numberWithCommas(
                    data.planLimit
                  )} Buzz across apps.`}
            </Text>
            <Text size="xs" c="dimmed">
              Apps are paused until {resumes}.
              {data.canOptIn &&
                ` You can keep going on your own Buzz today, up to ${numberWithCommas(
                  data.optInLimit
                )}. Each app's own limit still applies.`}
            </Text>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {/* A new tab: following it must not unload the app the viewer is in the middle of. */}
          <Button
            component={NextLink}
            href="/pricing"
            target="_blank"
            rel="noopener"
            size="compact-sm"
            data-testid="app-buzz-cap-upgrade"
          >
            Upgrade for a higher limit
          </Button>
          {data.canOptIn && (
            <Button
              size="compact-sm"
              variant="default"
              loading={optingIn}
              data-testid="app-buzz-cap-opt-in"
              onClick={onOptIn}
            >
              Continue on my own Buzz today
            </Button>
          )}
        </Group>
      </Group>
    </Box>
  );
}

/** Mounted by the host only for a live run with a signed-in viewer and the flag on. */
export function AppBuzzCapNotice() {
  const utils = trpc.useUtils();
  const query = trpc.user.getAppBuzzCap.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const optIn = trpc.user.optInAppBuzzToday.useMutation({
    onSuccess: (status) => utils.user.getAppBuzzCap.setData(undefined, status),
  });
  return (
    <AppBuzzCapNoticeView
      data={query.data}
      now={Date.now()}
      optingIn={optIn.isPending}
      onOptIn={() => optIn.mutate()}
    />
  );
}
