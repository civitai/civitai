import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconArrowRight, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

const ALERT_ID = 'nav-tidy-notice';

/**
 * Floating popover that appears right under the sub nav, where the Posts /
 * Events tabs used to live, letting users know they were tidied away and can
 * be turned back on from their account settings. Mirrors the dismiss pattern
 * used by {@link ./YellowBuzzMigrationNotice}.
 */
export function NavTidyNotice() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const enabled = !!currentUser;
  // AppProvider seeds `user.getSettings` with SSR initialData and the global
  // `staleTime: Infinity` prevents refetching — so `data` is truthy immediately
  // with potentially stale `dismissedAlerts`. Gate on `isFetched` (only true
  // after a real network fetch resolves) and force a refetch via `staleTime: 0`.
  const { data: settings, isFetched: settingsFetched } = trpc.user.getSettings.useQuery(undefined, {
    enabled,
    staleTime: 0,
  });
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
  });

  // Only nudge users who actually have one of the tidied items hidden.
  const hasHiddenNavItem = !features.postsNavItem || !features.eventsNavItem;
  const show = enabled && settingsFetched && !isDismissed && hasHiddenNavItem;

  const handleDismiss = () => dismissMutation.mutate({ alertId: ALERT_ID });

  if (!show) return null;

  return (
    <Popover
      width={280}
      position="bottom-start"
      shadow="lg"
      opened
      // Stay put until the user explicitly closes it via the X — clicking away
      // or pressing Escape should not permanently dismiss the nudge.
      closeOnClickOutside={false}
      closeOnEscape={false}
      withArrow
      arrowSize={10}
    >
      <Popover.Target>
        <div className="inline-flex cursor-help text-yellow-7" aria-label="Navigation updated">
          <IconInfoCircle size={18} />
        </div>
      </Popover.Target>
      <Popover.Dropdown className="border border-yellow-9/30 p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <Text size="sm" fw={600} style={{ color: '#f59f00' }}>
              We tidied up the nav
            </Text>
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
            We trimmed a few items from the navigation to keep things simple. Miss Posts or Events?
            You can turn them back on anytime in your settings.
          </Text>

          <Button
            component={Link}
            href="/user/account#settings"
            variant="light"
            color="yellow"
            size="compact-xs"
            radius="xl"
            rightSection={<IconArrowRight size={12} />}
            className="self-start"
          >
            Manage in settings
          </Button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
