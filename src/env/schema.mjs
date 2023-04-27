// @ts-check
import { z } from 'zod';
import { zc } from '~/utils/schema-helpers';
import { stringArray } from '~/utils/zod-helpers';

/**
 * Specify your server-side environment variables schema here.
 * This way you can ensure the app isn't built with invalid env vars.
 */
export const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_REPLICA_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  REDIS_TIMEOUT: z.preprocess((x) => x ? parseInt(String(x)) : 5000, z.number().optional()),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  NEXTAUTH_SECRET: z.string(),
  NEXTAUTH_URL: z.preprocess(
    // This makes Vercel deployments not fail if you don't set NEXTAUTH_URL
    // Since NextAuth automatically uses the VERCEL_URL if present.
    (str) => process.env.VERCEL_URL ?? str,
    // VERCEL_URL doesnt include `https` so it cant be validated as a URL
    process.env.VERCEL ? z.string() : z.string().url()
  ),
  CLICKHOUSE_HOST: z.string().optional(),
  CLICKHOUSE_USERNAME: z.string().optional(),
  CLICKHOUSE_PASSWORD: z.string().optional(),
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
  S3_ORIGINS: z.preprocess((value) => {
    const str = String(value);
    return str.split(',');
  }, z.array(z.string().url()).optional()),
  S3_UPLOAD_SECRET: z.string(),
  S3_UPLOAD_REGION: z.string(),
  S3_UPLOAD_ENDPOINT: z.string().url(),
  S3_UPLOAD_BUCKET: z.string(),
  S3_SETTLED_BUCKET: z.string(),
  S3_FORCE_PATH_STYLE: z
    .preprocess((val) => val === true || val === 'true', z.boolean())
    .default(false),
  RATE_LIMITING: zc.booleanString,
  CF_ACCOUNT_ID: z.string(),
  CF_IMAGES_TOKEN: z.string(),
  JOB_TOKEN: z.string(),
  WEBHOOK_TOKEN: z.string(),
  SCANNING_ENDPOINT: z.string(),
  SCANNING_TOKEN: z.string(),
  UNAUTHENTICATED_DOWNLOAD: zc.booleanString,
  UNAUTHENTICATED_LIST_NSFW: zc.booleanString,
  SHOW_SFW_IN_NSFW: zc.booleanString,
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_DONATE_ID: z.string(),
  STRIPE_METADATA_KEY: z.string(),
  LOGGING: stringArray(),
  IMAGE_SCANNING_ENDPOINT: z.string().optional(),
  IMAGE_SCANNING_CALLBACK: z.string().optional(),
  DELIVERY_WORKER_ENDPOINT: z.string().optional(),
  DELIVERY_WORKER_TOKEN: z.string().optional(),
  PLAYFAB_TITLE_ID: z.string().optional(),
  PLAYFAB_SECRET_KEY: z.string().optional(),
  TRPC_ORIGINS: stringArray().optional(),
});

/**
 * Specify your client-side environment variables schema here.
 * This way you can ensure the app isn't built with invalid env vars.
 * To expose them to the client, prefix them with `NEXT_PUBLIC_`.
 */
export const clientSchema = z.object({
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string(),
  NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION: z.string(),
  NEXT_PUBLIC_IMAGE_LOCATION: z.string(),
  NEXT_PUBLIC_CIVITAI_LINK: z.string().url(),
  NEXT_PUBLIC_GIT_HASH: z.string().optional(),
});

/**
 * You can't destruct `process.env` as a regular object, so you have to do
 * it manually here. This is because Next.js evaluates this at build time,
 * and only used environment variables are included in the build.
 * @type {{ [k in keyof z.infer<typeof clientSchema>]: z.infer<typeof clientSchema>[k] | undefined }}
 */
export const clientEnv = {
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION: process.env.NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION,
  NEXT_PUBLIC_IMAGE_LOCATION: process.env.NEXT_PUBLIC_IMAGE_LOCATION,
  NEXT_PUBLIC_GIT_HASH: process.env.NEXT_PUBLIC_GIT_HASH,
  NEXT_PUBLIC_CIVITAI_LINK: process.env.NEXT_PUBLIC_CIVITAI_LINK,
};
