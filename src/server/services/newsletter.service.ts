import { beehiiv } from '~/server/integrations/beehiiv';
import { UpdateSubscriptionSchema } from '~/server/schema/newsletter.schema';

export async function updateSubscription({
  email,
  ...input
}: UpdateSubscriptionSchema & { email?: string }) {
  if (!email) throw new Error('No email provided');

  await beehiiv.setSubscription({ email, subscribed: input.subscribed });
}

export async function getSubscription(email?: string) {
  if (!email) throw new Error('No email provided');

  const subscription = await beehiiv.getSubscription(email);
  const subscribed = subscription?.status === 'active';
  return { subscribed };
}
