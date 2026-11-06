import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { PushPromptVariant } from '~/components/Notifications/pushPrompt';
import {
  decidePushPrompt,
  isAskableBrowser,
  isPushAskSnoozed,
  isPushPromptMoment,
} from '~/components/Notifications/pushPrompt';
import { usePushBrowserState } from '~/components/Notifications/usePushSubscription';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

const PushOptInDialog = dynamic(() => import('~/components/Notifications/PushOptInDialog'));

const ARM_AFTER_MS = 20_000;
// Per browser, not per tab: several tabs opened together would each ask otherwise.
const SHOWN_AT_KEY = 'push-optin-prompt-shown-at';
const SHOW_AGAIN_AFTER_MS = 12 * 60 * 60 * 1000;
// Where a modal would interrupt work in progress (generating, training, uploading, editing, paying),
// or where push is already asked about. Matched against the route pattern.
export const EXCLUDED_ROUTE =
  /^\/(generate|purchase|pricing|payment|redeem-code|claim|train|training|training-studio|avatar-generator|comics\/project|models\/train|user\/(notifications|account|membership|stripe-connect))\b|\/(create|edit|wizard)\b/;

function readShownRecently() {
  try {
    const at = Number(localStorage.getItem(SHOWN_AT_KEY));
    return !!at && Date.now() - at < SHOW_AGAIN_AFTER_MS;
  } catch {
    return false;
  }
}

function markShown() {
  try {
    localStorage.setItem(SHOWN_AT_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the server-side budget still bounds re-asks.
  }
}

/** Armed after the first in-app navigation or ARM_AFTER_MS on the page, so it never covers the page they came to. */
function useArmed(enabled: boolean) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!enabled || armed) return;
    // A background tab waits until it is looked at.
    const arm = () => {
      if (document.visibilityState === 'visible') setArmed(true);
      else document.addEventListener('visibilitychange', arm, { once: true });
    };
    const timer = setTimeout(arm, ARM_AFTER_MS);
    router.events.on('routeChangeComplete', arm);
    return () => {
      clearTimeout(timer);
      router.events.off('routeChangeComplete', arm);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [enabled, armed, router.events]);
  return armed;
}

/**
 * The site-wide push opt-in, shown at a visit under the same "Not now" budget as the settings-page
 * card (PushSoftAsk). Mounted once in BaseLayout, so it reads browser state only and queries
 * nothing until the moment to ask has come.
 */
export function PushOptInPrompt({ blocked }: { blocked: boolean }) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { support, permission } = usePushBrowserState();
  const dialogOpen = useDialogStore((s) => s.dialogs.length > 0);
  const browser = { signedIn: !!currentUser, blocked, support, permission };
  const armed = useArmed(isAskableBrowser(browser));
  // 'closed' once shown this mount, so closing it never re-decides.
  const [variant, setVariant] = useState<PushPromptVariant | 'closed' | null>(null);

  const moment = {
    ...browser,
    // Read when armed rather than at mount, so a tab opened later sees another tab's prompt.
    shownRecently: armed && readShownRecently(),
    armed,
    hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    dialogOpen,
    routeExcluded: EXCLUDED_ROUTE.test(router.pathname),
  };
  const ready = !variant && isPushPromptMoment(moment);
  const { data: settings, isSuccess: settingsLoaded } = trpc.user.getSettings.useQuery(undefined, {
    enabled: ready,
  });
  const snoozed = isPushAskSnoozed(settings);
  const { data: subscriptions } = trpc.notification.getPushSubscriptions.useQuery(undefined, {
    enabled: ready && settingsLoaded && !snoozed,
  });
  const decided = variant
    ? null
    : decidePushPrompt({
        ...moment,
        settingsLoaded,
        snoozed,
        otherDevice: subscriptions === undefined ? undefined : subscriptions.length > 0,
      });

  useEffect(() => {
    if (!decided) return;
    markShown();
    setVariant(decided);
  }, [decided]);

  if (!variant || variant === 'closed') return null;
  return <PushOptInDialog variant={variant} onDone={() => setVariant('closed')} />;
}
