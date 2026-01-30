// @ts-check
import * as z from 'zod';
import { isProd } from './other';

/**
 * Specify your client-side environment variables schema here.
 * This way you can ensure the app isn't built with invalid env vars.
 * To expose them to the client, prefix them with `NEXT_PUBLIC_`.
 */
export const clientSchema = z.object({
  NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION: z.string().default(''),
  NEXT_PUBLIC_IMAGE_LOCATION: z.string().default(''),
  NEXT_PUBLIC_CIVITAI_LINK: isProd ? z.url() : z.url().optional(),
  NEXT_PUBLIC_GIT_HASH: z.string().optional(),
  NEXT_PUBLIC_PICFINDER_WS_ENDPOINT: z.url().optional(),
  NEXT_PUBLIC_PICFINDER_API_KEY: z.string().optional(),
  NEXT_PUBLIC_SEARCH_HOST: z.url().optional(),
  NEXT_PUBLIC_SEARCH_CLIENT_KEY: z.string().optional(),
  NEXT_PUBLIC_SIGNALS_ENDPOINT: z.string().optional(),
  NEXT_PUBLIC_USER_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_MODEL_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_CHAT_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_POST_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_GPTT_UUID: z.string().optional(),
  NEXT_PUBLIC_GPTT_UUID_ALT: z.string().optional(),
  NEXT_PUBLIC_GPTT_UUID_GREEN: z.string().optional(),
  NEXT_PUBLIC_BASE_URL: z.string().optional(),
  NEXT_PUBLIC_UI_HOMEPAGE_IMAGES: z.stringbool().default(true),
  NEXT_PUBLIC_LOG_TRPC: z.stringbool().default(false),
  NEXT_PUBLIC_RECAPTCHA_KEY: z.string().optional(),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().optional(),
  NEXT_PUBLIC_CHOPPED_ENDPOINT: z.url().optional(),
  NEXT_PUBLIC_SERVER_DOMAIN_GREEN: z.string().optional(),
  NEXT_PUBLIC_SERVER_DOMAIN_BLUE: z.string().optional(),
  NEXT_PUBLIC_SERVER_DOMAIN_RED: z.string().optional(),
  NEXT_PUBLIC_PADDLE_TOKEN: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER: z.enum(['Stripe', 'Paddle']).default('Stripe'),
  NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY: z.string().optional(),
  NEXT_PUBLIC_CF_INVISIBLE_TURNSTILE_SITEKEY: z.string().optional(),
  NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY: z.string().optional(),
  // Auth proxy URL for PR previews - when set, OAuth flows redirect through this URL
  // instead of handling locally (e.g., "https://auth.civitaic.com")
  NEXT_PUBLIC_AUTH_PROXY_URL: z.string().optional(),
});

/**
 * You can't destruct `process.env` as a regular object, so you have to do
 * it manually here. This is because Next.js evaluates this at build time,
 * and only used environment variables are included in the build.
 * @type {{ [k in keyof z.infer<typeof clientSchema>]: z.infer<typeof clientSchema>[k] | undefined }}
 */
export const clientEnv = {
  NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION: process.env.NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION,
  NEXT_PUBLIC_IMAGE_LOCATION: process.env.NEXT_PUBLIC_IMAGE_LOCATION,
  NEXT_PUBLIC_GIT_HASH: process.env.NEXT_PUBLIC_GIT_HASH,
  NEXT_PUBLIC_CIVITAI_LINK: process.env.NEXT_PUBLIC_CIVITAI_LINK,
  NEXT_PUBLIC_PICFINDER_WS_ENDPOINT: process.env.NEXT_PUBLIC_PICFINDER_WS_ENDPOINT,
  NEXT_PUBLIC_PICFINDER_API_KEY: process.env.NEXT_PUBLIC_PICFINDER_API_KEY,
  NEXT_PUBLIC_SEARCH_HOST: process.env.NEXT_PUBLIC_SEARCH_HOST,
  NEXT_PUBLIC_SEARCH_CLIENT_KEY: process.env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  NEXT_PUBLIC_SIGNALS_ENDPOINT: process.env.NEXT_PUBLIC_SIGNALS_ENDPOINT,
  NEXT_PUBLIC_USER_LOOKUP_URL: process.env.NEXT_PUBLIC_USER_LOOKUP_URL,
  NEXT_PUBLIC_MODEL_LOOKUP_URL: process.env.NEXT_PUBLIC_MODEL_LOOKUP_URL,
  NEXT_PUBLIC_CHAT_LOOKUP_URL: process.env.NEXT_PUBLIC_CHAT_LOOKUP_URL,
  NEXT_PUBLIC_POST_LOOKUP_URL: process.env.NEXT_PUBLIC_POST_LOOKUP_URL,
  NEXT_PUBLIC_GPTT_UUID: process.env.NEXT_PUBLIC_GPTT_UUID,
  NEXT_PUBLIC_GPTT_UUID_ALT: process.env.NEXT_PUBLIC_GPTT_UUID_ALT,
  NEXT_PUBLIC_GPTT_UUID_GREEN: process.env.NEXT_PUBLIC_GPTT_UUID_GREEN,
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXTAUTH_URL,
  NEXT_PUBLIC_UI_HOMEPAGE_IMAGES: process.env.NEXT_PUBLIC_UI_HOMEPAGE_IMAGES,
  NEXT_PUBLIC_LOG_TRPC: process.env.NEXT_PUBLIC_LOG_TRP,
  NEXT_PUBLIC_RECAPTCHA_KEY: process.env.NEXT_PUBLIC_RECAPTCHA_KEY,
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
  NEXT_PUBLIC_CHOPPED_ENDPOINT: process.env.NEXT_PUBLIC_CHOPPED_ENDPOINT,
  NEXT_PUBLIC_SERVER_DOMAIN_GREEN: process.env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  NEXT_PUBLIC_SERVER_DOMAIN_BLUE: process.env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  NEXT_PUBLIC_SERVER_DOMAIN_RED: process.env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_PADDLE_TOKEN: process.env.NEXT_PUBLIC_PADDLE_TOKEN,
  // Default to Stripe in case the env var is not set
  NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER:
    process.env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER === 'Paddle' ? 'Paddle' : 'Stripe',
  NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY: process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY,
  NEXT_PUBLIC_CF_INVISIBLE_TURNSTILE_SITEKEY:
    process.env.NEXT_PUBLIC_CF_INVISIBLE_TURNSTILE_SITEKEY,
  NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY: process.env.NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY,
  NEXT_PUBLIC_AUTH_PROXY_URL: process.env.NEXT_PUBLIC_AUTH_PROXY_URL,
};
