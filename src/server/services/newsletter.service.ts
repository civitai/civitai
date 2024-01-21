import { mailchimp } from '~/server/integrations/mailchimp';
import { UpdateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import { dbRead } from '../db/client';
import dayjs from 'dayjs';
import { UserSettingsSchema } from '../schema/user.schema';
import { setUserSetting } from '~/server/services/user.service';

export async function updateSubscription({
  userId,
  username,
  ...input
}: UpdateSubscriptionSchema & { username?: string; userId?: number }) {
  if (!input.email) throw new Error('No email provided');

  await mailchimp.setSubscription({
    username,
    email: input.email!,
    subscribed: input.subscribed,
  });
  if (userId) setUserSetting(userId, { newsletterSubscriber: input.subscribed });
}

export async function getSubscription(email?: string) {
  if (!email) return { subscribed: false, showNewsletterDialog: true };

  const subscription = await mailchimp.getSubscription(email);
  const subscribed = !!subscription && ['subscribed', 'pending'].includes(subscription.status);

  const user = await dbRead.user.findFirst({ where: { email }, select: { settings: true } });
  const settings = user?.settings as UserSettingsSchema | null;

  return {
    subscribed,
    showNewsletterDialog:
      !settings?.newsletterDialogLastSeenAt ||
      new Date(settings.newsletterDialogLastSeenAt) <= new Date(),
  };
}

export async function postponeSubscription(userId: number) {
  await setUserSetting(userId, { newsletterDialogLastSeenAt: dayjs().add(1, 'week').toDate() });
}
