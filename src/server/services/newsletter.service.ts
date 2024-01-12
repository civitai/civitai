import { mailchimp } from '~/server/integrations/mailchimp';
import { UpdateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import { dbRead, dbWrite } from '../db/client';
import dayjs from 'dayjs';
import { UserSettingsSchema } from '../schema/user.schema';

export async function updateSubscription({
  sessionEmail,
  ...input
}: UpdateSubscriptionSchema & { username?: string; sessionEmail?: string }) {
  const email = input.email || sessionEmail;
  if (!email) throw new Error('No email provided');

  await mailchimp.setSubscription({
    email,
    username: input.username,
    subscribed: input.subscribed,
  });
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
      !!settings?.showNewsletterDialogAt && new Date(settings.showNewsletterDialogAt) <= new Date(),
  };
}

export async function postponeSubscription(userId: number) {
  const user = await dbWrite.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) return null;

  await dbWrite.user.update({
    where: { id: userId },
    data: {
      settings: {
        ...(user.settings as UserSettingsSchema),
        showNewsletterDialogAt: dayjs().add(1, 'week').toDate(),
      },
    },
  });
}
