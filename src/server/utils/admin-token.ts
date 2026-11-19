import { env } from '~/env/server';
import { webhookTokenValues } from '~/server/utils/webhook-token';

const ADMIN_ENDPOINT_TOKENS = [
  'SYSTEM_ACCOUNT_KEY_TOKEN',
  'SYSTEM_ACCOUNT_PROFILE_TOKEN',
  'PROVIDER_DOWNLOAD_TOKEN_ADMIN_TOKEN',
] as const;

/**
 * An admin endpoint's token, or undefined (the endpoint is unconfigured) while it is unset or
 * equals any other admin token: the webhook, probe and job tokens, or another admin endpoint's.
 */
export function distinctAdminToken(
  name: (typeof ADMIN_ENDPOINT_TOKENS)[number]
): string | undefined {
  const token = env[name];
  if (!token) return undefined;
  const others = [
    ...webhookTokenValues(),
    env.PROBE_TOKEN,
    env.JOB_TOKEN,
    ...ADMIN_ENDPOINT_TOKENS.filter((other) => other !== name).map((other) => env[other]),
  ];
  return others.includes(token) ? undefined : token;
}
