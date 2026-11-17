import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { NextApiRequest } from 'next';
import { matchWebhookToken } from '~/server/utils/webhook-token';

/**
 * A per-provider download token is `<provider>:<secret>`, sent as `?token=` on the download routes.
 * `provider` is the orchestrator's provider name as spelled on `WorkerClient.provider` (`RunPods`,
 * `FalAI`); `secret` is 64 hex characters. Only the SHA-256 of the secret is stored.
 *
 * No API key or OAuth token this repo mints contains `:` (hex, or `civitai_` plus hex), so any
 * `?token=` containing `:` is treated as a provider token, and one that does not resolve is refused rather than read as anonymous.
 */
export const PROVIDER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** `permanent`: the token can never be unretired. `planned`: a roll, which can be undone. */
export type ProviderTokenRetiredFor = 'permanent' | 'planned';

/** One entry of the `provider-download-tokens` KeyValue row. */
export type ProviderTokenRecord = {
  /** Names the token to the admin endpoint; not secret. */
  id: string;
  provider: string;
  /** SHA-256 of the secret, hex. */
  hash: string;
  mintedAt: string;
  retiredAt: string | null;
  retiredFor: ProviderTokenRetiredFor | null;
  /** Granted downloads per clock hour. */
  hourlyCeiling: number;
};

/** What a request can use: an unretired token whose provider is a registered worker provider. */
export type LiveProviderToken = Pick<ProviderTokenRecord, 'provider' | 'hash' | 'hourlyCeiling'>;

export const isProviderToken = (token: string) => token.includes(':');

export function parseProviderToken(token: string): { provider: string; secret: string } | null {
  const at = token.indexOf(':');
  if (at < 0) return null;
  const provider = token.slice(0, at);
  const secret = token.slice(at + 1);
  if (!PROVIDER_NAME_RE.test(provider) || !secret) return null;
  return { provider, secret };
}

export const hashProviderSecret = (secret: string) =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export const generateProviderSecret = () => randomBytes(32).toString('hex');
export const generateProviderTokenId = () => randomBytes(6).toString('hex');

/**
 * The live token `token` names, or null. Every live token of the named provider is compared, in
 * constant time, whether or not an earlier one matched.
 */
export function matchProviderToken(
  token: string,
  live: readonly LiveProviderToken[]
): LiveProviderToken | null {
  const parsed = parseProviderToken(token);
  if (!parsed) return null;
  const presented = Buffer.from(hashProviderSecret(parsed.secret), 'hex');
  let match: LiveProviderToken | null = null;
  for (const candidate of live) {
    if (candidate.provider !== parsed.provider) continue;
    const stored = Buffer.from(candidate.hash, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = candidate;
  }
  return match;
}

/** The row's entries, dropping any that are not shaped like one. */
export function parseProviderTokenRecords(value: unknown): ProviderTokenRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ProviderTokenRecord =>
      !!entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.provider === 'string' &&
      PROVIDER_NAME_RE.test(entry.provider) &&
      typeof entry.hash === 'string' &&
      /^[0-9a-f]{64}$/.test(entry.hash) &&
      typeof entry.hourlyCeiling === 'number' &&
      entry.hourlyCeiling > 0
  );
}

export function liveProviderTokens(
  records: readonly ProviderTokenRecord[],
  registeredProviders: ReadonlySet<string>
): LiveProviderToken[] {
  return records
    .filter((record) => !record.retiredAt && registeredProviders.has(record.provider))
    .map(({ provider, hash, hourlyCeiling }) => ({ provider, hash, hourlyCeiling }));
}

export type ProviderTokenParam =
  | { kind: 'none' }
  | { kind: 'duplicate' }
  | { kind: 'provider'; token: string };

/**
 * Reads `?token=` for a per-provider download token. When one is present it is removed from
 * `req.query` and `req.url`, so no session code sees it and no log line this app writes after this
 * point carries it. A `?token=` without `:` is left alone: it is a user API key.
 *
 * A `?token=` that is exactly a configured webhook token is left alone too, even if it contains `:`.
 * Session code already skips that value, so such a request keeps being served as it was before
 * provider tokens existed.
 */
export function takeProviderToken(req: NextApiRequest): ProviderTokenParam {
  const raw = req.query.token;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (!values.some((value) => isProviderToken(value) && !matchWebhookToken(value)))
    return { kind: 'none' };

  delete req.query.token;
  if (req.url) {
    const queryAt = req.url.indexOf('?');
    if (queryAt >= 0) {
      const params = new URLSearchParams(req.url.slice(queryAt + 1));
      params.delete('token');
      const rest = params.toString();
      req.url = req.url.slice(0, queryAt) + (rest ? `?${rest}` : '');
    }
  }
  return values.length === 1 ? { kind: 'provider', token: values[0] } : { kind: 'duplicate' };
}
