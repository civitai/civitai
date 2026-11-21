import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { CIVITAI_OWNED_DOMAINS, registrableDomain } from '@civitai/auth';
import { env } from '~/env/server';
import { HUB_BASE_URL } from '~/server/auth/oauth-bridge';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  FeaturePageMineInput,
  FeaturePageVoteInput,
} from '~/server/schema/feature-pages.schema';
import { fetchThroughCache, setFetchThroughCache } from '~/server/utils/cache-helpers';
import { outboundFetch } from '~/server/utils/fetch-timeout';

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
  feature: string
): { src: string; origin: string } | null {
  if (!embedUrl) return null;
  let url: URL;
  try {
    url = new URL(embedUrl);
  } catch {
    return null;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  const site = registrableDomain(url.hostname.replace(/\.$/, ''));
  if (site && (CIVITAI_OWNED_DOMAINS as readonly string[]).includes(site)) return null;
  url.searchParams.set('feature', feature);
  return { src: url.href, origin: url.origin };
}

function signerConfig() {
  const { FEATURE_PAGES_SIGNER_URL, FEATURE_PAGES_CLIENT_ID, FEATURE_PAGES_CLIENT_SECRET } = env;
  if (!FEATURE_PAGES_SIGNER_URL || !FEATURE_PAGES_CLIENT_ID || !FEATURE_PAGES_CLIENT_SECRET)
    return null;
  if (!HUB_BASE_URL) return null;
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
  const res = await outboundFetch(`${HUB_BASE_URL}/api/auth/oauth/token`, {
    timeoutMs: HUB_TOKEN_TIMEOUT_MS,
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

async function postToSigner(path: string, body: Record<string, unknown>): Promise<unknown> {
  const config = signerConfig();
  if (!config)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Feature pages are not set up' });

  const send = (token: string) =>
    outboundFetch(`${config.signerUrl}${path}`, {
      timeoutMs: SIGNER_TIMEOUT_MS,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    throw tryAgain();
  }

  if (res.status === 401 || res.status >= 500) {
    log({ message: 'signer error', path, status: res.status });
    throw tryAgain();
  }
  if (res.status === 429) throw new TRPCError({ code: 'TOO_MANY_REQUESTS' });
  if (!res.ok) throw new TRPCError({ code: 'FORBIDDEN', message: 'Refused' });
  try {
    return await res.json();
  } catch (e) {
    log({ message: 'signer reply unreadable', path, error: safeError(e) });
    throw tryAgain();
  }
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
