import { env } from '~/env/server';
import { webhookTokenValues } from '~/server/utils/webhook-token';

const ADMIN_ENDPOINT_TOKENS = [
  'SYSTEM_ACCOUNT_KEY_TOKEN',
  'SYSTEM_ACCOUNT_PROFILE_TOKEN',
  'PROVIDER_DOWNLOAD_TOKEN_ADMIN_TOKEN',
  'SESSION_RESET_TOKEN',
] as const;

export type AdminEndpointTokenName = (typeof ADMIN_ENDPOINT_TOKENS)[number];

/** Every configured shared or admin token value: webhook, probe, job and each admin endpoint's. */
export function configuredTokenValues(except?: AdminEndpointTokenName): string[] {
  return [
    ...webhookTokenValues(),
    env.PROBE_TOKEN,
    env.JOB_TOKEN,
    ...ADMIN_ENDPOINT_TOKENS.filter((other) => other !== except).map((other) => env[other]),
  ].filter((value): value is string => !!value);
}

/**
 * An admin endpoint's token, or undefined (the endpoint is unconfigured) while it is unset or
 * equals any other admin token: the webhook, probe and job tokens, or another admin endpoint's.
 * Compared trimmed, so a stray newline on one secret cannot make two equal tokens look distinct.
 */
export function distinctAdminToken(name: AdminEndpointTokenName): string | undefined {
  const token = env[name];
  if (!token) return undefined;
  const trimmed = token.trim();
  return configuredTokenValues(name).some((other) => other.trim() === trimmed) ? undefined : token;
}
