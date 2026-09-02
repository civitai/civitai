import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';
import { useFeatureNotice } from '~/components/Alerts/useFeatureNotice';
import { useFeatureFlags, useFeatureFlagsReady } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { BuzzBoltSvg } from '~/components/User/BuzzBoltSvg';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useSyncAccount } from '~/hooks/useSyncAccount';

/**
 * Floating popover card that wraps children (e.g. UserMenu) and shows
 * a Yellow Buzz migration notice anchored below them.
 */
export function YellowBuzzMigrationNotice({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const serverDomains = useServerDomains();
  const syncAccount = useSyncAccount();

  const enabled = !!currentUser && !!features.isGreen && !!features.buzz;
  const ready = useFeatureFlagsReady();
  // Shares the `getBuzzAccount` cache with the global buzz display (signal-kept
  // live) — no need to force a refetch here.
  const { data: buzzAccounts } = trpc.buzz.getBuzzAccount.useQuery(undefined, { enabled });
  const { isDismissed, hasSettings, dismiss } = useFeatureNotice(
    FEATURE_NOTICES.yellowBuzzMigration,
    // `useFeatureNotice` ANDs in "is signed in" itself, so pass only the extra
    // conditions.
    { enabled: !!features.isGreen && !!features.buzz }
  );

  const yellowBalance = buzzAccounts?.yellow ?? 0;
  // `hasSettings` waits for a resolved settings object so a rare failed SSR
  // snapshot cannot flash this at someone who already dismissed it; on the
  // normal SSR-seeded path it is true on the first render, so there is no delay.
  const show = enabled && ready && hasSettings && !isDismissed && yellowBalance > 0;

  const handleDismiss = () => dismiss();

  if (!show) return <>{children}</>;

  const redDomain = serverDomains.red;
  const redUrl = syncAccount(`//${redDomain}/`);

  return (
    <Popover
      width={280}
      position="bottom-end"
      shadow="lg"
      opened
      onChange={(opened) => {
        if (!opened) handleDismiss();
      }}
      withArrow
      arrowSize={10}
    >
      <Popover.Target>
        <div className="inline-flex">{children}</div>
      </Popover.Target>
      <Popover.Dropdown className="border border-yellow-9/30 p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <BuzzBoltSvg size={18} color="#f59f00" fill="#f59f00" />
              <Text size="sm" fw={600} style={{ color: '#f59f00' }}>
                Yellow Buzz has moved
              </Text>
            </div>
            <CloseButton
              size="xs"
              variant="subtle"
              color="gray"
              radius="xl"
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="shrink-0"
            />
          </div>

          <Text size="xs" c="dimmed" lh={1.4}>
            Your{' '}
            <Text span fw={600} style={{ color: '#f59f00' }}>
              {abbreviateNumber(yellowBalance, { floor: true })} Yellow Buzz
            </Text>{' '}
            is now on{' '}
            <Text span fw={600} className="text-red-4">
              civitai.red
            </Text>
            . Same account, ready to use.
          </Text>

          <Button
            component="a"
            href={redUrl}
            target="_blank"
            rel="noreferrer nofollow"
            variant="light"
            color="red"
            size="compact-xs"
            radius="xl"
            rightSection={<IconArrowRight size={12} />}
            className="self-start"
          >
            View on civitai.red
          </Button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
