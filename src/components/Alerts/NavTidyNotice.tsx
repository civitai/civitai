import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconArrowRight, IconInfoCircle } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';
import { useFeatureNotice } from '~/components/Alerts/useFeatureNotice';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';
import { useFeatureFlags, useFeatureFlagsReady } from '~/providers/FeatureFlagsProvider';

const SubNavSettingsModal = dynamic(
  () => import('~/components/HomeContentToggle/SubNavSettingsModal'),
  { ssr: false }
);
const openSubNavSettings = createDialogTrigger(SubNavSettingsModal);

/**
 * Floating popover under the sub nav, where the Posts / Events tabs used to live. The audience is
 * unchanged — users who have one of those items tidied away — but the destination is now the
 * sub-nav customization modal, because that is where placement lives. The account switches it used
 * to point at are gone; leaving the link would have sent people to a page with nothing on it.
 */
export function NavTidyNotice() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const enabled = !!currentUser;
  const ready = useFeatureFlagsReady();
  const { isDismissed, hasSettings, dismiss } = useFeatureNotice(FEATURE_NOTICES.navTidy);

  // Only nudge users who actually have one of the tidied items hidden.
  const hasHiddenNavItem = !features.postsNavItem || !features.eventsNavItem;
  // Two separate gates. `ready` waits for the per-user feature-flag overlay, so
  // `hasHiddenNavItem` is read from real flags rather than defaults.
  // `hasSettings` waits for a resolved settings object, so a rare failed SSR
  // snapshot cannot flash this at someone who already dismissed it; on the
  // normal SSR-seeded path it is true on the first render, so there is no delay.
  const show = enabled && ready && hasSettings && !isDismissed && hasHiddenNavItem;

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

  const handleDismiss = () => dismiss();

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
            You can put them back — and reorder the rest — from here.
          </Text>

          <Button
            onClick={() => openSubNavSettings()}
            variant="light"
            color="yellow"
            size="compact-xs"
            radius="xl"
            rightSection={<IconArrowRight size={12} />}
            className="self-start"
          >
            Customize navigation
          </Button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
