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
  // This is not a no-op tidy-up. `setUserSetting` used to be a bare `$executeRaw`
  // that silently no-op'd on a missing row; it now throws NOT_FOUND on a zero-row
  // update (deliberately — a moderator acting on a deleted user must not get a
  // success back). Un-awaited and uncaught, as this call was, that rejection
  // became an UNHANDLED PROMISE REJECTION rather than a failed request: nothing in
  // the mutation's own control flow could see it. The realistic path is narrow —
  // `userId` is session-derived, so the row normally exists — but an account
  // deleted or merged mid-request reaches it.
  //
  // The `await` is deliberate too: it keeps the write inside the request's
  // lifetime instead of racing the response, which is what makes the
  // unhandled-rejection shape structurally impossible rather than merely handled.
  if (userId) {
    try {
      await setUserSetting(userId, { newsletterSubscriber: input.subscribed });
    } catch (error) {
      logToAxiom({
        type: 'newsletter.settings-mirror.failed',
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
