import { useCallback } from 'react';
import dayjs from 'dayjs';
import { usePushSubscription } from '~/components/Notifications/usePushSubscription';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import type { PushSupport } from '~/store/push-subscription.store';
import type { PUSH_PROMPT_ACTIONS, PUSH_PROMPT_VARIANTS } from '~/server/schema/track.schema';
import { trpc } from '~/utils/trpc';

// One re-ask budget for every surface that asks: "Not now" anywhere spends it.
const MAX_DISMISSALS = 3;
const REASK_AFTER_DAYS = 90;

export type PushPromptAction = (typeof PUSH_PROMPT_ACTIONS)[number];
export type PushPromptVariant = (typeof PUSH_PROMPT_VARIANTS)[number];
export type PushPromptSurface = 'visit-prompt' | 'settings-card';

export function isPushAskSnoozed(
  settings: { pushPromptDismissedCount?: number; pushPromptDismissedAt?: Date | null } | undefined,
  now = new Date()
) {
  const count = settings?.pushPromptDismissedCount ?? 0;
  if (count >= MAX_DISMISSALS) return true;
  const at = settings?.pushPromptDismissedAt;
  return !!at && dayjs(now).diff(dayjs(at), 'day') < REASK_AFTER_DAYS;
}

export type PushPromptState = {
  signedIn: boolean;
  /** Banned, or the onboarding wizard is up. */
  blocked: boolean;
  support: PushSupport;
  permission: NotificationPermission | null;
  settingsLoaded: boolean;
  snoozed: boolean;
  /** Shown in this browser recently (any tab). */
  shownRecently: boolean;
  /** A first in-app navigation happened, or the visitor has been on the page for a while. */
  armed: boolean;
  /** The tab is in the background, where nobody would see it. */
  hidden: boolean;
  dialogOpen: boolean;
  routeExcluded: boolean;
  /** Whether the user has push on another device; undefined until known. */
  otherDevice: boolean | undefined;
};

/**
 * Only a browser that has never been asked (`default`). A denial cannot be re-requested from code;
 * `granted` without a subscription is most often someone who turned push off here on purpose, so
 * finishing that is left to the settings card.
 */
export function isAskableBrowser(
  s: Pick<PushPromptState, 'signedIn' | 'blocked' | 'support' | 'permission'>
) {
  return s.signedIn && !s.blocked && s.support === 'supported' && s.permission === 'default';
}

/** Every precondition except settings and the other-device lookup, which are only worth a query once these pass. */
export function isPushPromptMoment(
  s: Omit<PushPromptState, 'settingsLoaded' | 'snoozed' | 'otherDevice'>
) {
  return (
    isAskableBrowser(s) &&
    !s.shownRecently &&
    s.armed &&
    !s.hidden &&
    !s.dialogOpen &&
    !s.routeExcluded
  );
}

/** Which prompt to show the visitor now, or null for none. */
export function decidePushPrompt(s: PushPromptState): PushPromptVariant | null {
  if (!isPushPromptMoment(s) || !s.settingsLoaded || s.snoozed) return null;
  if (s.otherDevice === undefined) return null;
  return s.otherDevice ? 'another-device' : 'new';
}

/**
 * Tracking, the shared dismissal budget and a tracked enable(), for one surface. A native prompt
 * closed without a choice counts as "Not now": browsers start muting a site that re-asks quickly.
 * A failed subscribe does not.
 */
export function usePushPromptActions(
  surface: PushPromptSurface,
  variant: PushPromptVariant,
  platform: 'desktop' | 'mobile'
) {
  const { enable, busy } = usePushSubscription();
  const { trackAction } = useTrackEvent();
  const { data: settings } = trpc.user.getSettings.useQuery();
  const queryUtils = trpc.useUtils();
  // Invalidated from the hook options, not mutate(): the visit prompt unmounts on close, and
  // mutate()'s own callbacks do not run for an unmounted caller.
  const setSettingsMutation = trpc.user.setSettings.useMutation({
    onSettled: () => queryUtils.user.getSettings.invalidate(),
  });

  const track = useCallback(
    (action: PushPromptAction) =>
      trackAction({
        type: 'Push_Prompt',
        details: { action, surface, variant, platform },
      }).catch(() => undefined),
    [trackAction, surface, variant, platform]
  );

  const spendDismissal = useCallback(() => {
    const patch = {
      pushPromptDismissedCount: (settings?.pushPromptDismissedCount ?? 0) + 1,
      pushPromptDismissedAt: new Date(),
    };
    // Written to the cache first, so the settings card reads the snooze at once and a second
    // dismissal counts from the new value.
    queryUtils.user.getSettings.setData(undefined, (old) => (old ? { ...old, ...patch } : old));
    setSettingsMutation.mutate(patch);
  }, [setSettingsMutation, settings?.pushPromptDismissedCount, queryUtils]);

  const notNow = useCallback(() => {
    track('not_now');
    spendDismissal();
  }, [track, spendDismissal]);

  const enableTracked = useCallback(async () => {
    // enable() is a no-op while another surface's call is in flight; nothing to record.
    if (busy) return false;
    track('enable_click');
    // Read from the browser, not the push store: the store keeps a single importer (its SSR guard).
    const before = Notification.permission;
    const ok = await enable();
    const after = Notification.permission;
    if (after === 'granted' && before !== 'granted') track('granted');
    if (ok) track('subscribed');
    else if (after === 'denied') track('denied');
    else if (after === 'default') {
      track('native_dismissed');
      spendDismissal();
    } else track('failed');
    return ok;
  }, [track, enable, busy, spendDismissal]);

  return { track, notNow, enable: enableTracked };
}
