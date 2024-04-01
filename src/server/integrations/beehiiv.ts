import { env } from '~/env/server.mjs';
import { CacheTTL } from '~/server/common/constants';
import { redis } from '~/server/redis/client';
import { createLogger } from '~/utils/logging';

const connected = !!env.NEWSLETTER_KEY && !!env.NEWSLETTER_ID;
const log = createLogger('newsletter', 'green');

async function beehiivRequest({
  endpoint,
  method,
  body,
}: {
  endpoint: string;
  method: string;
  body?: MixedObject;
}) {
  let url = `https://api.beehiiv.com/v2/${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.NEWSLETTER_KEY}`,
  };

  if (method === 'GET') {
    delete headers['Content-Type'];
    url += `?${new URLSearchParams(body).toString()}`;
    body = undefined;
  }

  const result = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
    .then((res) => res.json())
    .catch((err) => {
      throw new Error(`Error calling ${url}: ${err.message}`);
    });

  return result;
}

function newsletterHandler<T, R>(fn: (input: T) => Promise<R>) {
  return async (input: T) => {
    if (!connected) {
      log('Newsletter not setup');
      return null;
    }
    return fn(input);
  };
}

type Subscription = {
  id: string;
  email: string;
  status:
    | 'active'
    | 'validating'
    | 'invalid'
    | 'pending'
    | 'active'
    | 'inactive'
    | 'needs_attention';
  created: number;
  subscription_tier: string;
  utm_source: string;
  utm_medium: string;
  utm_channel:
    | 'website'
    | 'import'
    | 'embed'
    | 'api'
    | 'referral'
    | 'recommendation'
    | 'magic_link'
    | 'boost';
  utm_campaign: string;
  referring_site: string;
  referral_code: string;
};

const getRedisKey = (email: string) => `newsletter:${email.replace(/[^a-z0-9]/gi, '_')}`;

const getSubscription = newsletterHandler(async (email: string) => {
  if (!email) return undefined;

  const subscriptionCache = await redis.get(getRedisKey(email));
  if (subscriptionCache) {
    if (subscriptionCache === 'not-subscribed') return undefined;
    return JSON.parse(subscriptionCache) as Subscription | undefined;
  }

  const subscriptions = await beehiivRequest({
    endpoint: `publications/${env.NEWSLETTER_ID}/subscriptions`,
    method: 'GET',
    body: { email },
  });
  const subscription = subscriptions?.data?.[0] as Subscription | undefined;
  await redis.set(getRedisKey(email), JSON.stringify(subscription ?? 'not-subscribed'), {
    EX: CacheTTL.day,
  });
  return subscription;
});

const setSubscription = newsletterHandler(
  async ({ email, subscribed }: { email: string; subscribed: boolean }) => {
    const subscription = await getSubscription(email);
    if (!subscription && !subscribed) return;
    const active = subscription?.status === 'active';

    if (!active) {
      if (!subscribed) return;
      await beehiivRequest({
        endpoint: `publications/${env.NEWSLETTER_ID}/subscriptions`,
        method: 'POST',
        body: {
          email,
          reactivate_existing: true,
          utm_source: 'Civitai',
          utm_medium: 'organic',
          utm_campaign: 'Civitai',
        },
      });
    } else {
      if (subscribed) return;
      await beehiivRequest({
        endpoint: `publications/${env.NEWSLETTER_ID}/subscriptions/${subscription.id}`,
        method: 'PATCH',
        body: {
          unsubscribe: !subscribed,
        },
      });
    }
    await redis.del(getRedisKey(email));
  }
);

export const beehiiv = {
  getSubscription,
  setSubscription,
};
