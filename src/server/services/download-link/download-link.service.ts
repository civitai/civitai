import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  GenerationFetchPrincipal,
  GenerationFetchRefusal,
  ProviderFetchPrincipal,
} from '~/server/services/download-link/generation-fetch.service';
import { checkGenerationFetch } from '~/server/services/download-link/generation-fetch.service';
import type { DownloadLinkCredential } from '~/server/services/download-link/download-link.store';
import {
  createLink,
  findReusableLink,
  isAllowlistedMinter,
  isLinkToken,
  isOverFetchCap,
  linksAreReusable,
  mayMintProviderLinks,
  mayMintPublicLinks,
  recordFetch,
  takeMintBudget,
  credentialKey,
  secretEpoch,
} from '~/server/services/download-link/download-link.store';
import { serveProviderFetch } from '~/server/services/provider-download/provider-download.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { logUrlExpiry } from '~/server/utils/url-expiry-log';
import type { Session } from '~/types/session';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

export const DEFAULT_LINK_TTL_SECONDS = 24 * 60 * 60;
export const PROVIDER_LINK_TTL_SECONDS = 6 * 60 * 60;
const MINT_CONCURRENCY = 8;

/**
 * A link's fetch cap: `DOWNLOAD_LINK_MAX_FETCHES`, raised for large files. Older worker builds
 * fetch a large file as concurrent 64 MB ranges, each a separate GET of the link, so a flat cap
 * cuts them off partway through. One fetch per 32 MB, plus room for retries, is twice what one
 * complete multipart download spends.
 */
const FETCH_CAP_CHUNK_KB = 32 * 1024;
const FETCH_CAP_RETRY_ALLOWANCE = 20;
export const linkFetchCap = (sizeKB: number) =>
  Math.max(
    env.DOWNLOAD_LINK_MAX_FETCHES,
    Math.ceil(Math.max(0, sizeKB) / FETCH_CAP_CHUNK_KB) + FETCH_CAP_RETRY_ALLOWANCE
  );

export type MintItem = {
  modelVersionId: number;
  fileId?: number;
  ttlSeconds: number;
} & (
  | { mode: 'public' }
  | { mode: 'user'; onBehalfOfUserId: number; workflowId: string }
  | { mode: 'provider'; provider: DownloadLinkProvider }
);

export type DownloadLinkProvider = 'orchestrator';

export type MintError = GenerationFetchRefusal | 'rate-limited';
export type MintItemResult =
  | { ok: true; url: string; linkId: string; expiresAt: string; reused: boolean }
  | { ok: false; status: number; error: MintError };

const REFUSAL_STATUS: Record<MintError, number> = {
  'not-found': 404,
  'no-access': 403,
  'no-generation': 403,
  'early-access': 403,
  archived: 410,
  'failed-scan': 403,
  poi: 403,
  unauthorized: 403,
  'in-review': 403,
  'unsupported-file': 400,
  'rate-limited': 429,
};

const refused = (error: MintError): MintItemResult => ({
  ok: false,
  status: REFUSAL_STATUS[error],
  error,
});

/**
 * The flag's `mode` context: `api` for `/api/v1/download-links` and its links, `provider` for the
 * links mini hands a provider.
 */
export type DownloadLinkSurface = 'api' | 'provider';

/** Off, unknown or unreachable all read as off. */
export const downloadLinksEnabled = (mode: DownloadLinkSurface) =>
  isFlipt(FLIPT_FEATURE_FLAGS.DOWNLOAD_LINKS_ENABLED, undefined, { mode }).catch(() => false);

const linkUrl = (id: string) => `${getBaseUrl()}/api/download/l/${id}`;

/**
 * The user a link acts for, loaded fresh, as an ordinary (never moderator) principal. Null for a
 * user who is missing, banned or deleted.
 */
async function loadPrincipal(userId: number): Promise<GenerationFetchPrincipal | null> {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { id: true, bannedAt: true, deletedAt: true },
  });
  if (!user || user.bannedAt || user.deletedAt) return null;
  return { id: user.id, isModerator: false };
}

function logMint(
  credential: DownloadLinkCredential,
  item: MintItem,
  result: MintItemResult,
  fileId?: number
) {
  logToAxiom({
    name: 'download-link',
    type: 'info',
    message: 'mint',
    credentialKind: credential.kind,
    credentialId: credential.id,
    mode: item.mode,
    onBehalfOfUserId: item.mode === 'user' ? item.onBehalfOfUserId : null,
    workflowId: item.mode === 'user' ? item.workflowId : null,
    modelVersionId: item.modelVersionId,
    fileId: fileId ?? item.fileId ?? null,
    ok: result.ok,
    error: result.ok ? null : result.error,
    linkId: result.ok ? result.linkId : null,
    reused: result.ok ? result.reused : null,
  }).catch(() => undefined);
}

/**
 * The user a user item mints for, or why it is refused. Each user is loaded once and their budget
 * taken in one step for all their items; the earliest items in request order get what it grants.
 */
type ItemGate = { principal: GenerationFetchPrincipal | null } | { refusal: MintError };

async function gateItems(
  credential: DownloadLinkCredential,
  items: MintItem[],
  now: number
): Promise<ItemGate[]> {
  const byUser = new Map<number, number[]>();
  items.forEach((item, i) => {
    if (item.mode !== 'user') return;
    byUser.set(item.onBehalfOfUserId, [...(byUser.get(item.onBehalfOfUserId) ?? []), i]);
  });

  // A user item starts refused, so one never reaches mintOne without its principal (which would
  // mint a public link).
  const gates: ItemGate[] = items.map((item) =>
    item.mode === 'public' && mayMintPublicLinks(credential)
      ? { principal: null }
      : { refusal: 'unauthorized' }
  );
  await limitConcurrency(
    [...byUser].map(([userId, indexes]) => async () => {
      const principal = await loadPrincipal(userId);
      if (!principal) {
        for (const i of indexes) gates[i] = { refusal: 'unauthorized' };
        return;
      }
      const { granted } = await takeMintBudget(
        `user:${principal.id}`,
        indexes.length,
        env.DOWNLOAD_LINK_MINT_LIMIT_PER_USER,
        now
      );
      indexes.forEach((i, n) => {
        gates[i] = n < granted ? { principal } : { refusal: 'rate-limited' };
      });
    }),
    MINT_CONCURRENCY
  );
  return gates;
}

/** `takeFreshMintBudget`, when given, is asked only when no link can be reused. */
async function mintOne(
  credential: DownloadLinkCredential,
  item: MintItem,
  principal: GenerationFetchPrincipal | ProviderFetchPrincipal | null,
  now: number,
  takeFreshMintBudget?: () => Promise<boolean>
): Promise<MintItemResult> {
  const check = await checkGenerationFetch({
    modelVersionId: item.modelVersionId,
    fileId: item.fileId,
    principal,
    cacheReads: item.mode === 'provider',
  });
  if (!check.ok) return refused(check.error);

  const onBehalfOfUserId = principal && 'id' in principal ? principal.id : null;
  const provider = item.mode === 'provider' ? item.provider : null;
  const reusable = await findReusableLink({
    credential,
    fileId: check.fileId,
    onBehalfOfUserId,
    provider,
    now,
    minRemainingMs: env.DOWNLOAD_LINK_MIN_REUSE_SECONDS * 1000,
    maxExpiresAt: now + item.ttlSeconds * 1000,
  });
  if (reusable) {
    return {
      ok: true,
      url: linkUrl(reusable.id),
      linkId: reusable.link.linkId,
      expiresAt: new Date(reusable.link.expiresAt).toISOString(),
      reused: true,
    };
  }

  if (takeFreshMintBudget && !(await takeFreshMintBudget())) return refused('rate-limited');

  const expiresAt = now + item.ttlSeconds * 1000;
  const { id, linkId } = await createLink({
    // A provider link has no cap: older workers GET it once per range, and its lifetime bounds it.
    maxFetches: provider ? 0 : linkFetchCap(check.sizeKB),
    credential,
    onBehalfOfUserId,
    provider,
    // The link pins the version and file the check resolved, not the ones asked for.
    modelVersionId: check.modelVersionId,
    fileId: check.fileId,
    workflowId: item.mode === 'user' ? item.workflowId : '',
    mintedAt: now,
    expiresAt,
  });
  return {
    ok: true,
    url: linkUrl(id),
    linkId,
    expiresAt: new Date(expiresAt).toISOString(),
    reused: false,
  };
}

export type MintOutcome =
  | { status: 200; items: MintItemResult[] }
  | { status: 429; retryAfterSeconds: number }
  | { status: 503 };

/** Mints one link per item, answering each in request order. */
export async function mintDownloadLinks(
  credential: DownloadLinkCredential,
  items: MintItem[],
  now = Date.now()
): Promise<MintOutcome> {
  if (!(await downloadLinksEnabled('api'))) return { status: 503 };
  const budget = await takeMintBudget(
    `cred:${credentialKey(credential)}`,
    items.length,
    env.DOWNLOAD_LINK_MINT_LIMIT_PER_CREDENTIAL,
    now
  );
  if (!budget.allowed) return { status: 429, retryAfterSeconds: budget.retryAfterSeconds };

  const gates = await gateItems(credential, items, now);
  const results = new Array<MintItemResult>(items.length);
  await limitConcurrency(
    items.map((item, i) => async () => {
      const gate = gates[i];
      results[i] =
        'refusal' in gate
          ? refused(gate.refusal)
          : await mintOne(credential, item, gate.principal, now);
      logMint(credential, item, results[i]);
    }),
    MINT_CONCURRENCY
  );
  return { status: 200, items: results };
}

/**
 * A link `provider` fetches one file with as itself, minted for the credential calling mini. Null
 * when provider links are off: the flag, a credential not on the provider allowlist, or no
 * `DOWNLOAD_LINK_SECRET` (every call would then mint a new link). Only a fresh mint takes budget.
 */
export async function mintProviderLink(
  credential: DownloadLinkCredential,
  {
    provider,
    modelVersionId,
    fileId,
  }: { provider: DownloadLinkProvider; modelVersionId: number; fileId: number },
  now = Date.now()
): Promise<MintItemResult | null> {
  if (!linksAreReusable() || !mayMintProviderLinks(credential)) return null;
  if (!(await downloadLinksEnabled('provider'))) return null;
  const item: MintItem = {
    mode: 'provider',
    provider,
    modelVersionId,
    fileId,
    ttlSeconds: PROVIDER_LINK_TTL_SECONDS,
  };
  const result = await mintOne(credential, item, { kind: 'provider', provider }, now, () =>
    takeMintBudget(
      `cred:${credentialKey(credential)}`,
      1,
      env.DOWNLOAD_LINK_MINT_LIMIT_PER_CREDENTIAL,
      now
    ).then((budget) => budget.allowed)
  );
  // Mini asks on every call; a reuse is the common answer and says nothing new.
  if (!result.ok || !result.reused) logMint(credential, item, result);
  return result;
}

/** Whether the credential that minted a link may still be honoured. */
async function isCredentialLive(credential: DownloadLinkCredential, now: number) {
  if (!isAllowlistedMinter(credential)) return false;
  if (credential.kind === 'apikey') {
    const id = Number(credential.id);
    if (!Number.isInteger(id)) return false;
    const key = await dbRead.apiKey.findUnique({
      where: { id },
      select: { expiresAt: true, user: { select: { bannedAt: true, deletedAt: true } } },
    });
    return (
      !!key &&
      (!key.expiresAt || key.expiresAt.getTime() > now) &&
      !key.user.bannedAt &&
      !key.user.deletedAt
    );
  }
  const client = await dbRead.oauthClient.findUnique({
    where: { id: credential.id },
    select: {
      grants: true,
      allowedScopes: true,
      secret: true,
      user: { select: { bannedAt: true, deletedAt: true } },
    },
  });
  return (
    !!client &&
    secretEpoch(client.secret) === credential.epoch &&
    client.grants.includes('client_credentials') &&
    (client.allowedScopes & TokenScope.DownloadLink) !== 0 &&
    !client.user.bannedAt &&
    !client.user.deletedAt
  );
}

function logUse(linkId: string, outcome: string, fetch?: number) {
  logToAxiom({ name: 'download-link', type: 'info', message: 'use', linkId, outcome, fetch }).catch(
    () => undefined
  );
}

/** Logs why a fetch was refused and answers the refusal. */
function refuseUse(linkId: string, outcome: string, fetch: number): null {
  logUse(linkId, outcome, fetch);
  return null;
}

/**
 * One fetch of a link: a fresh signed file URL to redirect to, or null for every kind of refusal
 * (the route answers each with the same 404).
 */
export async function fetchDownloadLink({
  id,
  req,
  res,
  now = Date.now(),
}: {
  id: unknown;
  req: NextApiRequest;
  res: NextApiResponse;
  now?: number;
}): Promise<string | null> {
  if (!isLinkToken(id)) return null;
  const [apiEnabled, providerEnabled] = await Promise.all([
    downloadLinksEnabled('api'),
    downloadLinksEnabled('provider'),
  ]);
  if (!apiEnabled && !providerEnabled) return null;

  const counted = await recordFetch(id);
  if (!counted) return null;
  const { link, fetch } = counted;
  if (!(link.provider ? providerEnabled : apiEnabled)) return null;
  if (now >= link.expiresAt) return refuseUse(link.linkId, 'expired', fetch);
  if (isOverFetchCap(link, fetch)) return refuseUse(link.linkId, 'over-cap', fetch);
  const credential = {
    kind: link.credentialKind,
    id: link.credentialId,
    epoch: link.credentialEpoch,
  };
  if (!(await isCredentialLive(credential, now)))
    return refuseUse(link.linkId, 'credential-dead', fetch);

  if (link.provider) {
    if (!mayMintProviderLinks(credential)) return refuseUse(link.linkId, 'credential-dead', fetch);
    const check = await checkGenerationFetch({
      modelVersionId: link.modelVersionId,
      fileId: link.fileId,
      principal: { kind: 'provider', provider: link.provider },
      cacheReads: true,
    });
    if (check.ok && check.fileId !== link.fileId) return refuseUse(link.linkId, 'not-found', fetch);
    const served = await serveProviderFetch({
      req,
      res,
      provider: link.provider,
      check,
      expiresInSeconds: env.DOWNLOAD_LINK_FILE_URL_TTL_SECONDS,
    });
    if (!served.ok) return refuseUse(link.linkId, check.ok ? 'not-found' : check.error, fetch);
    logUse(link.linkId, 'redirect', fetch);
    return served.url;
  }

  let principal: GenerationFetchPrincipal | null = null;
  if (link.onBehalfOfUserId != null) {
    principal = await loadPrincipal(link.onBehalfOfUserId);
    if (!principal) return refuseUse(link.linkId, 'user-refused', fetch);
  } else if (!mayMintPublicLinks(credential)) {
    return refuseUse(link.linkId, 'credential-dead', fetch);
  }

  const check = await checkGenerationFetch({
    modelVersionId: link.modelVersionId,
    fileId: link.fileId,
    principal,
    cacheReads: true,
  });
  if (!check.ok || check.fileId !== link.fileId)
    return refuseUse(link.linkId, check.ok ? 'not-found' : check.error, fetch);

  if (fetch === 1) {
    // Not a `Download`: no download limiter, no downloads-cache bust. The session is the link's user,
    // so the row is theirs rather than the fetching provider's (which has no session).
    const session = principal ? ({ user: { id: principal.id } } as unknown as Session) : null;
    new Tracker(req, res, session)
      .modelVersionEvent({
        type: 'GenerationFetch',
        modelId: check.modelId,
        modelVersionId: check.modelVersionId,
        fileId: check.fileId,
        nsfw: check.nsfw,
        earlyAccess: check.inEarlyAccess,
        time: new Date(now),
      })
      .catch(() => undefined);
  }

  const { url, urlExpiryDate } = await resolveDownloadUrl(
    check.fileId,
    check.fileUrl,
    check.fileName,
    {
      caller: 'other',
      actor: 'internal',
      expiresInSeconds: env.DOWNLOAD_LINK_FILE_URL_TTL_SECONDS,
    }
  );
  logUrlExpiry({
    fileId: check.fileId,
    sizeKB: check.sizeKB,
    urlExpiresAt: new Date(urlExpiryDate),
    linkId: link.linkId,
  });
  logUse(link.linkId, 'redirect', fetch);
  return url;
}
