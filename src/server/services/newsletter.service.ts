import dayjs from '~/shared/utils/dayjs';
import type { UpdateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import { setUserSetting } from '~/server/services/user.service';

import { beehiiv } from '~/server/integrations/beehiiv';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import { dbRead } from '~/server/db/client';

export async function updateSubscription({
  email,
  userId,
  ...input
}: UpdateSubscriptionSchema & { email?: string; userId?: number }) {
  if (!email) throw new Error('No email provided');

  await beehiiv.setSubscription({ email, subscribed: input.subscribed });
  if (userId) setUserSetting(userId, { newsletterSubscriber: input.subscribed });
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
