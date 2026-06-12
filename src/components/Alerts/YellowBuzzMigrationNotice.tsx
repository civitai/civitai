import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useFeatureFlags, useFeatureFlagsReady } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { BuzzBoltSvg } from '~/components/User/BuzzBoltSvg';
import { abbreviateNumber } from '~/utils/number-helpers';
import { syncAccount } from '~/utils/sync-account';

const ALERT_ID = 'yellow-buzz-migration';

/**
 * Floating popover card that wraps children (e.g. UserMenu) and shows
 * a Yellow Buzz migration notice anchored below them.
 */
export function YellowBuzzMigrationNotice({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const serverDomains = useServerDomains();

  const enabled = !!currentUser && features.isGreen && features.buzz;
  const ready = useFeatureFlagsReady();
  // Shares the `getBuzzAccount` cache with the global buzz display (signal-kept
  // live) — no need to force a refetch here.
  const { data: buzzAccounts } = trpc.buzz.getBuzzAccount.useQuery(undefined, { enabled });
  // SSR-seeded `user.getSettings` + the dismiss mutation's optimistic cache
  // update keep `dismissedAlerts` authoritative without a per-mount refetch.
  const { data: settings } = trpc.user.getSettings.useQuery(undefined, { enabled });
  const isDismissed = (settings?.dismissedAlerts ?? []).includes(ALERT_ID);

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
    // Reconcile with server truth after the optimistic update: the optimistic
    // setData spreads `...old`, so if the cached base was incomplete (e.g. a
    // failed SSR settings snapshot) it could persist a truncated settings
    // object. Refetch once on dismiss to restore the full object + confirm the
    // stored dismissedAlerts. One request per dismiss (rare) — not per mount.
    onSettled: () => {
      utils.user.getSettings.invalidate();
    },
  });

  const yellowBalance = buzzAccounts?.yellow ?? 0;
  // `!!settings` guards the rare failed-SSR-snapshot path (undefined initialData):
  // don't render against undefined `dismissedAlerts` until the self-healing mount
  // fetch lands. Defined immediately on the normal SSR-seeded path → no delay.
  const show = enabled && ready && !!settings && !isDismissed && yellowBalance > 0;

  const handleDismiss = () => dismissMutation.mutate({ alertId: ALERT_ID });

  if (!show) return <>{children}</>;

  const redDomain = serverDomains.red;
  const redUrl = syncAccount(`//${redDomain}/`, '/user/buzz-dashboard');

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
