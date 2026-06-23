import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconArrowRight, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags, useFeatureFlagsReady } from '~/providers/FeatureFlagsProvider';
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
  const ready = useFeatureFlagsReady();
  // SSR-seeded `user.getSettings` + the dismiss mutation's optimistic cache
  // update keep `dismissedAlerts` authoritative without a per-mount refetch.
  // Gate visibility on `ready` (per-user flag overlay) instead.
  const { data: settings } = trpc.user.getSettings.useQuery(undefined, {
    enabled,
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
    // Reconcile with server truth after the optimistic update: the optimistic
    // setData spreads `...old`, so if the cached base was incomplete (e.g. a
    // failed SSR settings snapshot) it could persist a truncated settings
    // object. Refetch once on dismiss to restore the full object + confirm the
    // stored dismissedAlerts. One request per dismiss (rare) — not per mount.
    onSettled: () => {
      utils.user.getSettings.invalidate();
    },
  });

  // Only nudge users who actually have one of the tidied items hidden.
  const hasHiddenNavItem = !features.postsNavItem || !features.eventsNavItem;
  // `!!settings` guards the rare failed-SSR-snapshot path (undefined initialData):
  // don't render against undefined `dismissedAlerts` until the self-healing mount
  // fetch lands. Defined immediately on the normal SSR-seeded path → no delay.
  const show = enabled && ready && !!settings && !isDismissed && hasHiddenNavItem;

  // Open only AFTER the above-the-fold layout has settled. The popover is anchored
  // to a subnav target; opening it during the initial layout-settle window made its
  // dropdown paint while the target was still moving, registering a large layout
  // shift (the dominant home-page CLS contributor). A short post-mount defer lets it
  // paint once at its final position — no shift — without changing the nudge's intent.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!show) {
      setOpened(false);
      return;
    }
    const id = window.setTimeout(() => setOpened(true), 1500);
    return () => window.clearTimeout(id);
  }, [show]);

  const handleDismiss = () => dismissMutation.mutate({ alertId: ALERT_ID });

  if (!show) return null;

  return (
    <Popover
      width={280}
      position="bottom-start"
      shadow="lg"
      opened={opened}
      // Stay put until the user explicitly closes it via the X — clicking away
      // or pressing Escape should not permanently dismiss the nudge.
      closeOnClickOutside={false}
      closeOnEscape={false}
      withArrow
      arrowSize={10}
    >
      <Popover.Target>
        <div
          role="button"
          tabIndex={0}
          className="inline-flex cursor-help text-yellow-7"
          aria-label="Navigation updated"
        >
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
