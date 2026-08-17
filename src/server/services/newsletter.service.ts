import dayjs from '~/shared/utils/dayjs';
import type { UpdateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import { setUserSetting } from '~/server/services/user.service';

import { beehiiv } from '~/server/integrations/beehiiv';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import { dbRead } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';

export async function updateSubscription({
  email,
  userId,
  ...input
}: UpdateSubscriptionSchema & { email?: string; userId?: number }) {
  if (!email) throw new Error('No email provided');

  await beehiiv.setSubscription({ email, subscribed: input.subscribed });

  // 🔴 ORDER IS LOAD-BEARING, AND IT DECIDES WHAT THIS CATCH HAS TO DO.
  //
  // Beehiiv has already COMMITTED by this line, and there is no compensating call
  // that un-does it cleanly, so a throw here would report failure for an operation
  // that SUCCEEDED in the system of record. Beehiiv is that system of record:
  // `getSubscription` below reads the live subscription state from it, never from
  // this setting, and `settings.newsletterSubscriber` has no reader anywhere in
  // the repo — it is a denormalised mirror, not the authority. Worse, the client
  // rolls its optimistic toggle BACK on error (NewsletterToggle's `onError`), so a
  // throw would show a subscribed user an "unsubscribed" switch. A stale mirror is
  // the strictly smaller harm than a wrong answer about a real subscription.
  //
  // So: best-effort, logged, never fatal.
  //
  // This is not a no-op tidy-up, and the hazard is OLDER than it looks. Un-awaited
  // and uncaught, as this call was, ANY rejection from `setUserSetting` became an
  // UNHANDLED PROMISE REJECTION rather than a failed request — nothing in the
  // mutation's own control flow could see it. That was already true before the
  // settings writes were made atomic: the previous implementation
  // (`git show b6a2e537fa^:src/server/services/user.service.ts`) awaited a
  // `$executeRaw` AND `userSettingsCache().bust()` AND
  // `bustUserMetricPrivacyDefaultsCache()`, every one of which rejects on a DB or
  // Redis fault. So the un-awaited shape was never safe; do not read this as a
  // regression introduced by that change.
  //
  // What DID change is reachability. The old raw UPDATE matching zero rows was a
  // silent no-op, so a missing user produced no rejection at all; it now throws
  // NOT_FOUND (deliberately — a moderator acting on a deleted user must not get a
  // success back). That turned a fault-only hazard into a deterministic one on an
  // ordinary input. The path is still narrow — `userId` is session-derived, so the
  // row normally exists — but an account deleted or merged mid-request reaches it.
  //
  // The `await` is deliberate too: it keeps the write inside the request's
  // lifetime instead of racing the response, which is what makes the
  // unhandled-rejection shape structurally impossible rather than merely handled.
  if (userId) {
    try {
      await setUserSetting(userId, { newsletterSubscriber: input.subscribed });
    } catch (error) {
      // 🔴 `type` IS THE SEVERITY FIELD, not a free-text event name — the
      // Alloy→Loki pipeline extracts it as the log level (see the SEVERITY FIELD
      // note on `buildCentralErrorLog` in ~/server/logging/client). An event name
      // here would land the line at no recognised level, discoverable only by
      // someone who already knows the string — which would hollow out the entire
      // justification for swallowing this error. The event name goes in `name`.
      // Measured convention: of 601 `logToAxiom` sites with a literal `type`, 528
      // use a severity word, and 535 of the 545 severity-typed ones (98%) carry a
      // `name`. (The `api-key.service.ts` `type: 'oauth.*.failed'` shape this
      // originally copied is 2 sites of the 73-site minority.)
      //
      // `warning`, not `error`: this write is best-effort BY DESIGN and its
      // dominant reachable cause is a benign deleted/merged account, which is a
      // client-fault NOT_FOUND rather than a server incident — the same split
      // `classifyErrorFault` makes, and the reason the logging client routes
      // client faults away from the error stream so they cannot flood it. Nearest
      // in-tree precedent for a swallowed best-effort write failure is
      // `donation-goal-cache-bust-failed`, also `warning`. Escalate to `error` if
      // the volume ever says this is not the benign case.
      logToAxiom({
        type: 'warning',
        name: 'newsletter-settings-mirror-failed',
        message: `newsletterSubscriber mirror write failed for user ${userId}`,
        error: safeError(error),
      }).catch(() => {});
    }
  }
}

export async function getSubscription(email?: string) {
  if (!email) return { subscribed: false, showNewsletterDialog: true };

  const subscription = await beehiiv.getSubscription(email);
  const subscribed = subscription?.status === 'active';
  const user = await dbRead.user.findFirst({ where: { email }, select: { settings: true } });
  const settings = user?.settings as UserSettingsSchema | null;

  return {
    subscribed,
    showNewsletterDialog:
      !subscribed &&
      (!settings?.newsletterDialogLastSeenAt ||
        new Date(settings.newsletterDialogLastSeenAt) <= new Date()),
  };
}

export async function postponeSubscription(userId: number) {
  await setUserSetting(userId, { newsletterDialogLastSeenAt: dayjs().add(1, 'week').toDate() });
}
