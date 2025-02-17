// @ts-check
import { z } from 'zod';
import { zc } from '~/utils/schema-helpers';
import {
  booleanString,
  commaDelimitedStringArray,
  commaDelimitedStringObject,
  stringToArray,
} from '~/utils/zod-helpers';
import { isProd } from './other';

/**
 * Specify your server-side environment variables schema here.
 * This way you can ensure the app isn't built with invalid env vars.
 */
export const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_REPLICA_URL: z.string().url(),
  DATABASE_REPLICA_LONG_URL: z.string().url().optional(),
  DATABASE_SSL: zc.booleanString.default(true),
  NOTIFICATION_DB_URL: z.string().url(),
  NOTIFICATION_DB_REPLICA_URL: z.string().url(),
  DATABASE_CONNECTION_TIMEOUT: z.coerce.number().default(0),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  DATABASE_POOL_IDLE_TIMEOUT: z.coerce.number().default(30000),
  DATABASE_READ_TIMEOUT: z.coerce.number().optional(),
  DATABASE_WRITE_TIMEOUT: z.coerce.number().optional(),
  REDIS_URL: z.string().url(),
  REDIS_URL_DIRECT: commaDelimitedStringArray().default([]),
  REDIS_SYS_URL: z.string().url(),
  REDIS_TIMEOUT: z.preprocess((x) => (x ? parseInt(String(x)) : 5000), z.number().optional()),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  NEXTAUTH_SECRET: z.string(),
  NEXTAUTH_URL: z.preprocess(
    // This makes Vercel deployments not fail if you don't set NEXTAUTH_URL
    // Since NextAuth automatically uses the VERCEL_URL if present.
    (str) => process.env.VERCEL_URL ?? str,
    // VERCEL_URL doesnt include `https` so it cant be validated as a URL
    process.env.VERCEL ? z.string() : z.string().url()
  ),
  CLICKHOUSE_HOST: isProd ? z.string() : z.string().optional(),
  CLICKHOUSE_USERNAME: isProd ? z.string() : z.string().optional(),
  CLICKHOUSE_PASSWORD: isProd ? z.string() : z.string().optional(),
  CLICKHOUSE_TRACKER_URL: z.string().url().optional(),
  DISCORD_CLIENT_ID: z.string(),
  DISCORD_CLIENT_SECRET: z.string(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  REDDIT_CLIENT_ID: z.string(),
  REDDIT_CLIENT_SECRET: z.string(),
  EMAIL_HOST: z.string(),
  EMAIL_PORT: z.preprocess((x) => parseInt(String(x)), z.number()),
  EMAIL_SECURE: zc.booleanString,
  EMAIL_USER: z.string(),
  EMAIL_PASS: z.string(),
  EMAIL_FROM: z.string(),
  S3_UPLOAD_KEY: z.string(),
  S3_UPLOAD_SECRET: z.string(),
  S3_UPLOAD_REGION: z.string(),
  S3_UPLOAD_ENDPOINT: z.string().url(),
  S3_UPLOAD_BUCKET: z.string(),
  S3_IMAGE_UPLOAD_KEY: z.string().optional(),
  S3_IMAGE_UPLOAD_SECRET: z.string().optional(),
  S3_IMAGE_UPLOAD_REGION: z.string().optional(),
  S3_IMAGE_UPLOAD_ENDPOINT: z.string().url().optional(),
  S3_IMAGE_UPLOAD_BUCKET: z.string(),
  S3_IMAGE_UPLOAD_OVERRIDE: z.string().optional(),
  S3_IMAGE_UPLOAD_BUCKET_OLD: z.string().optional(),
  S3_IMAGE_CACHE_BUCKET: z.string().default(''),
  S3_IMAGE_CACHE_BUCKET_OLD: z.string().optional(),
  CF_ACCOUNT_ID: z.string().optional(),
  CF_IMAGES_TOKEN: z.string().optional(),
  CF_API_TOKEN: z.string().optional(),
  CF_ZONE_ID: z.string().optional(),
  JOB_TOKEN: z.string(),
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_TOKEN: z.string(),
  SCANNING_ENDPOINT: isProd ? z.string() : z.string().optional(),
  SCANNING_TOKEN: z.string(),
  UNAUTHENTICATED_DOWNLOAD: zc.booleanString,
  UNAUTHENTICATED_LIST_NSFW: zc.booleanString,
  LOGGING: commaDelimitedStringArray(),
  IMAGE_SCANNING_ENDPOINT: isProd ? z.string() : z.string().optional(),
  IMAGE_SCANNING_CALLBACK: z.string().optional(),
  IMAGE_SCANNING_MODEL: z.string().optional(),
  IMAGE_SCANNING_RETRY_DELAY: z.coerce.number().default(5),
  DELIVERY_WORKER_ENDPOINT: z.string().optional(),
  DELIVERY_WORKER_TOKEN: z.string().optional(),
  TRPC_ORIGINS: commaDelimitedStringArray().default([]),
  ORCHESTRATOR_ENDPOINT: isProd ? z.string().url() : z.string().url().optional(),
  ORCHESTRATOR_MODE: z.string().default('dev'),
  ORCHESTRATOR_ACCESS_TOKEN: z.string().default(''),
  ORCHESTRATOR_EXPERIMENTAL: booleanString().default(false),
  AXIOM_TOKEN: z.string().optional(),
  AXIOM_ORG_ID: z.string().optional(),
  AXIOM_DATASTREAM: z.string().optional(),
  SEARCH_HOST: z.string().url().optional(),
  SEARCH_API_KEY: z.string().optional(),
  METRICS_SEARCH_HOST: z.string().url().optional(),
  METRICS_SEARCH_API_KEY: z.string().optional(),
  PODNAME: z.string().optional(),
  FEATUREBASE_JWT_SECRET: z.string().optional(),
  INTEGRATION_TOKEN: z.string().optional(),
  FEATUREBASE_URL: z.string().url().optional(),
  NEWSLETTER_ID: z.string().optional(),
  NEWSLETTER_KEY: z.string().optional(),
  BUZZ_ENDPOINT: isProd ? z.string().url() : z.string().url().optional(),
  SIGNALS_ENDPOINT: isProd ? z.string().url() : z.string().url().optional(),
  CACHE_DNS: zc.booleanString,
  MINOR_FALLBACK_SYSTEM: zc.booleanString,
  CSAM_UPLOAD_KEY: z.string().default(''),
  CSAM_UPLOAD_SECRET: z.string().default(''),
  CSAM_BUCKET_NAME: z.string().default(''),
  CSAM_UPLOAD_REGION: z.string().default(''),
  CSAM_UPLOAD_ENDPOINT: z.string().default(''),
  NCMEC_URL: z.string().optional(),
  NCMEC_USERNAME: z.string().optional(),
  NCMEC_PASSWORD: z.string().optional(),
  RESOURCE_RECOMMENDER_URL: z.string().url().optional(),
  DIRNAME: z.string().optional(),
  IMAGE_QUERY_CACHING: zc.booleanString,
  POST_QUERY_CACHING: zc.booleanString,
  EXTERNAL_MODERATION_ENDPOINT: z.string().url().optional(),
  EXTERNAL_MODERATION_TOKEN: z.string().optional(),
  EXTERNAL_MODERATION_CATEGORIES: commaDelimitedStringObject().optional(),
  EXTERNAL_MODERATION_THRESHOLD: z.coerce.number().optional().default(0.5),
  BLOCKED_IMAGE_HASH_CHECK: zc.booleanString.optional().default(false),

  EXTERNAL_IMAGE_SCANNER: z.enum(['hive', 'rekognition']).optional().default('hive').catch('hive'),
  MINOR_SCANNER: z.enum(['custom', 'hive']).optional().catch(undefined),
  HIVE_VISUAL_TOKEN: z.string().optional(),

  ALT_ORCHESTRATION_ENDPOINT: z.string().url().optional(),
  ALT_ORCHESTRATION_TOKEN: z.string().optional(),
  ALT_ORCHESTRATION_TIMEFRAME: z
    .preprocess(
      (value) => {
        if (typeof value !== 'string') return null;

        const [start, end] = value.split(',').map((x) => new Date(x));
        return { start, end };
      },
      z.object({
        start: z.date().optional(),
        end: z.date().optional(),
      })
    )
    .optional(),
  REPLICATION_LAG_DELAY: z.coerce.number().default(0),
  RECAPTCHA_PROJECT_ID: z.string(),
  AIR_WEBHOOK: z.string().url().optional(),
  AIR_PAYMENT_LINK_ID: z.string().optional(),
  PAYPAL_API_URL: z.string().url().optional(),
  PAYPAL_SECRET: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  S3_VAULT_BUCKET: z.string().optional(),
  HEALTHCHECK_TIMEOUT: z.coerce.number().optional().default(1500),
  FRESHDESK_JWT_SECRET: z.string().optional(),
  FRESHDESK_JWT_URL: z.string().optional(),
  FRESHDESK_DOMAIN: z.string().optional(),
  FRESHDESK_TOKEN: z.string().optional(),
  UPLOAD_PROHIBITED_EXTENSIONS: commaDelimitedStringArray().optional(),
  POST_INTENT_DETAILS_HOSTS: z.preprocess(stringToArray, z.array(z.string().url()).optional()),
  CHOPPED_TOKEN: z.string().optional(),
  FINGERPRINT_SECRET: z.string().length(64).optional(),
  FINGERPRINT_IV: z.string().length(32).optional(),
  TIER_METADATA_KEY: z.string().default('tier'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_DONATE_ID: z.string().optional(),
  PADDLE_SECRET_KEY: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  CLOUDFLARE_TURNSTILE_SECRET: z.string().optional(),
  CF_INVISIBLE_TURNSTILE_SECRET: z.string().optional(),
  CF_MANAGED_TURNSTILE_SECRET: z.string().optional(),
  CONTENT_SCAN_ENDPOINT: isProd ? z.string() : z.string().optional(),
  CONTENT_SCAN_CALLBACK_URL: z.string().optional(),
  CONTENT_SCAN_MODEL: z.string().optional(),
  // TIPALTI. It uses a lot of little env vars, so we group them here.
  // iFrame Related:
  TIPALTI_PAYER_NAME: z.string().optional(),
  TIPALTI_PAYEE_DASHBOARD_URL: z.string().optional(),
  TIPALTI_IFRAME_KEY: z.string().optional(),
  TIPALTI_WEBTOKEN_SECRET: z.string().optional(),

  // API Related:
  TIPALTI_API_URL: z.string().optional(),
  TIPALTI_API_CLIENT_ID: z.string().optional(),
  TIPALTI_API_SECRET: z.string().optional(),
  TIPALTI_API_CODE_VERIFIER: z.string().optional(),
  TIPALTI_API_REFRESH_TOKEN: z.string().optional(),
  TIPALTI_API_TOKEN_URL: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),

  // Youtube related:
  YOUTUBE_APP_CLIENT_ID: z.string().optional(),
  YOUTUBE_APP_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_VIDEO_UPLOAD_URL: z.string().optional(),

  // Vimeo related:
  VIMEO_ACCESS_TOKEN: z.string().optional(),
  VIMEO_SECRET: z.string().optional(),
  VIMEO_CLIENT_ID: z.string().optional(),
  VIMEO_VIDEO_UPLOAD_URL: z.string().optional(),

  // Creator Program Related:
  CREATOR_POOL_TAXES: z.coerce.number().optional(),
  CREATOR_POOL_PORTION: z.coerce.number().optional(),
});

/**
 * Specify your client-side environment variables schema here.
 * This way you can ensure the app isn't built with invalid env vars.
 * To expose them to the client, prefix them with `NEXT_PUBLIC_`.
 */
export const clientSchema = z.object({
  NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION: z.string().default(''),
  NEXT_PUBLIC_IMAGE_LOCATION: z.string().default(''),
  NEXT_PUBLIC_CIVITAI_LINK: isProd ? z.string().url() : z.string().url().optional(),
  NEXT_PUBLIC_GIT_HASH: z.string().optional(),
  NEXT_PUBLIC_PICFINDER_WS_ENDPOINT: z.string().url().optional(),
  NEXT_PUBLIC_PICFINDER_API_KEY: z.string().optional(),
  NEXT_PUBLIC_SEARCH_HOST: z.string().url().optional(),
  NEXT_PUBLIC_SEARCH_CLIENT_KEY: z.string().optional(),
  NEXT_PUBLIC_SIGNALS_ENDPOINT: z.string().optional(),
  NEXT_PUBLIC_USER_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_MODEL_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_CHAT_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_POST_LOOKUP_URL: z.string().optional(),
  NEXT_PUBLIC_GPTT_UUID: z.string().optional(),
  NEXT_PUBLIC_BASE_URL: z.string().optional(),
  NEXT_PUBLIC_UI_HOMEPAGE_IMAGES: zc.booleanString.default(true),
  NEXT_PUBLIC_LOG_TRPC: zc.booleanString.default(false),
  NEXT_PUBLIC_RECAPTCHA_KEY: z.string().optional(),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().optional(),
  NEXT_PUBLIC_CHOPPED_ENDPOINT: z.string().url().optional(),
  NEXT_PUBLIC_SERVER_DOMAIN_GREEN: z.string().optional(),
  NEXT_PUBLIC_SERVER_DOMAIN_BLUE: z.string().optional(),
  NEXT_PUBLIC_SERVER_DOMAIN_RED: z.string().optional(),
  NEXT_PUBLIC_PADDLE_TOKEN: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER: z.enum(['Stripe', 'Paddle']).default('Stripe'),
  NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY: z.string().optional(),
  NEXT_PUBLIC_CF_INVISIBLE_TURNSTILE_SITEKEY: z.string().optional(),
  NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY: z.string().optional(),
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
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXTAUTH_URL,
  NEXT_PUBLIC_UI_HOMEPAGE_IMAGES: process.env.NEXT_PUBLIC_UI_HOMEPAGE_IMAGES !== 'false',
  NEXT_PUBLIC_LOG_TRPC: process.env.NEXT_PUBLIC_LOG_TRPC !== 'false',
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
};
