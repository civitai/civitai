import { mailchimp } from '~/server/integrations/mailchimp';
import { UpdateSubscriptionSchema } from '~/server/schema/newsletter.schema';

export async function updateSubscription({
  email,
  ...input
}: UpdateSubscriptionSchema & { email?: string }) {
  if (!email) throw new Error('No email provided');

  await mailchimp.setSubscription({ email, subscribed: input.subscribed });
}

export async function getSubscription(email?: string) {
  if (!email) throw new Error('No email provided');

  const subscription = await mailchimp.getSubscription(email);
  const subscribed = subscription && ['subscribed', 'pending'].includes(subscription.status);
  return { subscribed };
}
