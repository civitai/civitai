import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { CIVITAI_OWNED_DOMAINS, hubBaseUrl, hubFetch, registrableDomain } from '@civitai/auth';
import { env } from '~/env/server';
import { isLocalOrigin } from '~/env/local-origin';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  FeaturePageMineInput,
  FeaturePageVoteInput,
} from '~/server/schema/feature-pages.schema';
import { fetchThroughCache, setFetchThroughCache } from '~/server/utils/cache-helpers';
import { fetchTimeoutSignal, outboundFetch } from '~/server/utils/fetch-timeout';
import { FEATURE_PAGES_HOST_ORIGINS } from '~/shared/constants/feature-pages.constants';
import {
  PLATFORM_ROUTE_MISSING,
  platformRefusalSchema,
} from '~/server/services/feature-pages/platform-wire';

// The data.civitai.com platform's internal write path (no ingress), and the audience of its tokens.
const SIGNER_TOKEN_RESOURCE = 'https://data.civitai.com';
const SIGNER_VOTE_PATH = '/internal/vote';
const SIGNER_MINE_PATH = '/internal/mine';

const SIGNER_TIMEOUT_MS = 8_000;
const HUB_TOKEN_TIMEOUT_MS = 8_000;
// Hub service tokens live 15 minutes, and fetchThroughCache can hand out an entry up to one TTL past
// its refresh while another pod refreshes it, so the TTL stays under half the token's life.
const SERVICE_TOKEN_TTL_SECONDS = 5 * 60;
const SERVICE_TOKEN_KEY = REDIS_KEYS.CACHES.FEATURE_PAGES_SERVICE_TOKEN;

const log = (data: MixedObject) => logToAxiom({ name: 'feature-pages', type: 'error', ...data });

/**
 * The frame URL for a feature page, or null when the page must not render. The frame gets a real
 * origin (allow-same-origin), so it must not share a registrable domain with any of our sites: it
 * would receive their Domain= session cookies.
 */
export function resolveFeaturePageEmbed(
  embedUrl: string | undefined,
  feature: string,
  servingHost: string | undefined
): { src: string; origin: string } | null {
  if (!embedUrl) return null;
  // The frame trusts the host it is given, so only a listed origin is passed.
  const served = (servingHost ?? '').toLowerCase();
  const host = (FEATURE_PAGES_HOST_ORIGINS as readonly string[]).includes(`https://${served}`)
    ? `https://${served}`
    : served && env.NODE_ENV !== 'production' && isLocalOrigin(`http://${served}`, env.NODE_ENV)
    ? `http://${served}`
    : null;
  if (!host) return null;
  let url: URL;
  try {
    url = new URL(embedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalOrigin(url.href)))
    return null;
  const site = registrableDomain(url.hostname.replace(/\.$/, ''));
  if (site && (CIVITAI_OWNED_DOMAINS as readonly string[]).includes(site)) return null;
  url.searchParams.set('feature', feature);
  url.searchParams.set('host', host);
  return { src: url.href, origin: url.origin };
}

function signerConfig() {
  const { FEATURE_PAGES_SIGNER_URL, FEATURE_PAGES_CLIENT_ID, FEATURE_PAGES_CLIENT_SECRET } = env;
  if (!FEATURE_PAGES_SIGNER_URL || !FEATURE_PAGES_CLIENT_ID || !FEATURE_PAGES_CLIENT_SECRET)
    return null;
  if (!hubBaseUrl()) return null;
  return {
    signerUrl: FEATURE_PAGES_SIGNER_URL.replace(/\/+$/, ''),
    clientId: FEATURE_PAGES_CLIENT_ID,
    clientSecret: FEATURE_PAGES_CLIENT_SECRET,
  };
}
type SignerConfig = NonNullable<ReturnType<typeof signerConfig>>;

export const isFeaturePagesSignerConfigured = () => signerConfig() !== null;

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });

async function mintServiceToken({ clientId, clientSecret }: SignerConfig): Promise<string> {
  const basic = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  ).toString('base64');
  const res = await hubFetch('/api/auth/oauth/token', {
    signal: fetchTimeoutSignal(HUB_TOKEN_TIMEOUT_MS),
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: SIGNER_TOKEN_RESOURCE,
    }),
  });
  if (!res.ok) throw new Error(`hub service token refused: ${res.status}`);
  return tokenResponseSchema.parse(await res.json()).access_token;
}

const tryAgain = () =>
  new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Feature pages: try again' });

/** The platform did not answer: no token, no connection, or a timeout. Safe to retry. */
export class SignerUnavailableError extends Error {
  constructor(cause: unknown) {
    super('feature pages signer unavailable', { cause });
    this.name = 'SignerUnavailableError';
  }
}

export type SignerReply = { status: number; body: unknown };

/**
 * One call to the platform's internal write path with a cached service token, re-minted once on a
 * 401. Answers whatever status the platform gave; throws only when there was no answer.
 */
export async function callSigner(
  path: string,
  init:
    | { method: 'POST'; body: Record<string, unknown> }
    | { method: 'GET'; query: URLSearchParams }
): Promise<SignerReply> {
  const config = signerConfig();
  if (!config)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Feature pages are not set up' });

  const url =
    init.method === 'GET'
      ? `${config.signerUrl}${path}?${init.query.toString()}`
      : `${config.signerUrl}${path}`;
  const send = (token: string) =>
    outboundFetch(url, {
      timeoutMs: SIGNER_TIMEOUT_MS,
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
    });

  let res: Response;
  try {
    const token = await fetchThroughCache(SERVICE_TOKEN_KEY, () => mintServiceToken(config), {
      ttl: SERVICE_TOKEN_TTL_SECONDS,
    });
    res = await send(token);
    if (res.status === 401) {
      const fresh = await mintServiceToken(config);
      await setFetchThroughCache(SERVICE_TOKEN_KEY, fresh, { ttl: SERVICE_TOKEN_TTL_SECONDS });
      res = await send(fresh);
    }
  } catch (e) {
    log({ message: 'signer call failed', path, error: safeError(e) });
    throw new SignerUnavailableError(e);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** The refusal code of a non-2xx answer (`{ code, message, details }`), if it has one. */
export function signerErrorCode(reply: SignerReply): string | undefined {
  const parsed = platformRefusalSchema.safeParse(reply.body);
  return parsed.success ? parsed.data.code : undefined;
}

/**
 * A 404 is a refusal only when the platform names the record it does not know. A 404 for a route
 * it does not have (a deploy gap) is retried, and is an error worth seeing.
 */
export function isRouteMissing(reply: SignerReply) {
  if (reply.status !== 404) return false;
  const code = signerErrorCode(reply);
  return !code || code === PLATFORM_ROUTE_MISSING;
}

async function postToSigner(path: string, body: Record<string, unknown>): Promise<unknown> {
  let reply: SignerReply;
  try {
    reply = await callSigner(path, { method: 'POST', body });
  } catch (e) {
    if (e instanceof SignerUnavailableError) throw tryAgain();
    throw e;
  }
  const { status } = reply;
  if (status === 401 || status >= 500) {
    log({ message: 'signer error', path, status });
    throw tryAgain();
  }
  if (isRouteMissing(reply)) {
    log({ message: 'signer route missing', path, status });
    throw tryAgain();
  }
  if (status === 429) throw new TRPCError({ code: 'TOO_MANY_REQUESTS' });
  if (status < 200 || status >= 300) throw new TRPCError({ code: 'FORBIDDEN', message: 'Refused' });
  if (reply.body === null) {
    log({ message: 'signer reply unreadable', path });
    throw tryAgain();
  }
  return reply.body;
}

const voteReplySchema = z.object({ votes: z.number().int().nonnegative() });
const mineReplySchema = z.object({
  votes: z.record(z.string(), z.union([z.literal(0), z.literal(1)])),
});

function parseReply<T>(schema: z.ZodType<T>, reply: unknown, path: string): T {
  const parsed = schema.safeParse(reply);
  if (parsed.success) return parsed.data;
  log({ message: 'signer reply has the wrong shape', path });
  throw tryAgain();
}

/** The viewer's vote on one request; returns the request's new tally. */
export async function castFeaturePageVote(userId: number, input: FeaturePageVoteInput) {
  const reply = await postToSigner(SIGNER_VOTE_PATH, {
    uid: userId,
    request: input.request,
    value: input.value,
  });
  return parseReply(voteReplySchema, reply, SIGNER_VOTE_PATH);
}

/** The viewer's own votes on the given requests, keyed by request URN. */
export async function getMyFeaturePageVotes(userId: number, input: FeaturePageMineInput) {
  const reply = await postToSigner(SIGNER_MINE_PATH, { uid: userId, requests: input.requests });
  return parseReply(mineReplySchema, reply, SIGNER_MINE_PATH);
}
