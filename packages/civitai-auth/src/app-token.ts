import { hubFetch } from './hub';
import { loadAuthEnv } from './env';

export interface MintAppTokenInput {
  userId: number;
  clientId: string;
  scope: bigint;
  ttlSeconds?: number;
  /** The moderator acting as `userId`, or null. The hub mints nothing for an impersonation. */
  impersonatedBy: number | null;
}

export interface MintedAppToken {
  accessToken: string;
  expiresAt: string;
  expiresIn: number;
  scope: bigint;
}

export class AppTokenError extends Error {
  constructor(public readonly code: string, public readonly status: number, description?: string) {
    super(description ?? code);
    this.name = 'AppTokenError';
  }
}

export async function mintAppToken(input: MintAppTokenInput): Promise<MintedAppToken> {
  const internal = loadAuthEnv().AUTH_INTERNAL_TOKEN;
  if (!internal) throw new AppTokenError('hub_not_configured', 0, 'AUTH_INTERNAL_TOKEN is not set');

  const res = await hubFetch('/api/auth/oauth/app-token', {
    method: 'POST',
    headers: { authorization: `Bearer ${internal}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, scope: Number(input.scope) }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AppTokenError(
      typeof data.error === 'string' ? data.error : 'server_error',
      res.status,
      typeof data.error_description === 'string' ? data.error_description : undefined
    );
  }
  return {
    accessToken: data.access_token as string,
    expiresAt: data.expires_at as string,
    expiresIn: data.expires_in as number,
    scope: BigInt(data.scope as number),
  };
}
