import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import {
  REDIS_KEYS,
  REDIS_SYS_KEYS,
  redis,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { boundedClusterCall, takeClusterWindowCount } from '~/server/utils/cluster-window-count';

/**
 * Redis storage for download links, on the cache cluster. Each command touches one key, so no
 * MULTI or script spans slots: a link is written key by key, its hash first, and deleted key by
 * key. Every cluster call is bounded by the cluster cache guard and throws on a failure or timeout.
 *
 * The cluster can evict a key before its TTL. A lost link hash 404s that link (the client mints
 * another); a lost `linkid` or credential-set entry means a revoke misses that link, which then
 * lives until its expiry (at most MAX_LINK_TTL_SECONDS). A revoked or rotated credential is still
 * refused at every use by its liveness check; a single-link revoke has no such second check.
 *
 * A link's URL carries an `id`; Redis holds only `sha256(id)`. The id is derived from the link's
 * public `linkId` with `DOWNLOAD_LINK_SECRET`, which is what lets a repeat mint return the same URL
 * without storing it. Without the secret the id is random and repeat mints make new links.
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 22 base62 characters hold 128 bits. */
export const LINK_ID_LENGTH = 22;
const LINK_ID_RE = /^[0-9A-Za-z]{22}$/;
/** The credential set outlives every link in it: the longest link lasts this long. */
export const MAX_LINK_TTL_SECONDS = 24 * 60 * 60;

export type DownloadLinkCredential = {
  kind: 'client' | 'apikey';
  id: string;
  /** A client's `secretEpoch` when it minted; a link minted before a secret rotation is dead. */
  epoch?: string;
};

/** Fingerprint of an OauthClient's stored secret hash: changes when its secret is rotated. */
export const secretEpoch = (storedSecret: string | null) =>
  createHash('sha256')
    .update(`download-link-epoch:${storedSecret ?? ''}`)
    .digest('hex')
    .slice(0, 16);
export const credentialKey = (credential: DownloadLinkCredential) =>
  `${credential.kind}:${credential.id}`;

export type StoredDownloadLink = {
  credentialKind: DownloadLinkCredential['kind'];
  credentialId: string;
  /** The minting client's `secretEpoch`; empty for an ApiKey. */
  credentialEpoch: string;
  /** null for a public or provider link. */
  onBehalfOfUserId: number | null;
  /** The provider a provider link serves, fetching as itself; null for any other link. */
  provider: string | null;
  modelVersionId: number;
  fileId: number;
  workflowId: string;
  linkId: string;
  mintedAt: number;
  expiresAt: number;
  fetches: number;
  /** This link's fetch cap, fixed at mint from the file's size. A provider link has none. */
  maxFetches: number;
};

function toBase62(bytes: Buffer) {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  const base = BigInt(62);
  while (n > BigInt(0)) {
    out = BASE62[Number(n % base)] + out;
    n /= base;
  }
  return out.padStart(LINK_ID_LENGTH, '0').slice(-LINK_ID_LENGTH);
}

export const randomLinkToken = () => toBase62(randomBytes(16));
export const isLinkToken = (value: unknown): value is string =>
  typeof value === 'string' && LINK_ID_RE.test(value);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const deriveId = (secret: string, linkId: string) =>
  toBase62(createHmac('sha256', secret).update(linkId).digest().subarray(0, 16));

const MIN_SECRET_LENGTH = 32;
// Read on every call, never cached, so a rotated secret applies at once. Ids are derived from
// linkIds, which are logged, so a short secret is treated as no secret.
const linkSecret = () => {
  const secret = env.DOWNLOAD_LINK_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
};
export const linksAreReusable = () => linkSecret() !== undefined;

const linkKey = (hash: string) => `${REDIS_KEYS.DOWNLOAD_LINK.LINK}:${hash}` as const;
const linkIdKey = (linkId: string) => `${REDIS_KEYS.DOWNLOAD_LINK.LINK_ID}:${linkId}` as const;
const credSetKey = (credential: DownloadLinkCredential) =>
  `${REDIS_KEYS.DOWNLOAD_LINK.CRED_LINKS}:${credentialKey(credential)}` as const;
type LinkAudience = Pick<StoredDownloadLink, 'onBehalfOfUserId' | 'provider'>;
export const reuseKey = (
  credential: DownloadLinkCredential,
  fileId: number,
  { onBehalfOfUserId, provider }: LinkAudience
) =>
  `${REDIS_KEYS.DOWNLOAD_LINK.REUSE}:${credentialKey(credential)}:${fileId}:${
    onBehalfOfUserId ?? (provider ? `provider:${provider}` : 'public')
  }` as const;

/**
 * Until this date a link the cluster does not hold is also looked for in sysRedis, where links
 * minted before the move were written: read, fetch-counted and revoked there. Past it every such
 * link has expired (MAX_LINK_TTL_SECONDS); delete the fallback (the `sys*` keys and every branch on
 * this date) and REDIS_SYS_KEYS.DOWNLOAD_LINK with it. Reuse is never looked up there: a miss
 * mints a new link.
 */
export const DOWNLOAD_LINK_SYS_FALLBACK_UNTIL = new Date('2027-01-15T00:00:00Z');
const sysFallbackOpen = () => Date.now() < DOWNLOAD_LINK_SYS_FALLBACK_UNTIL.getTime();
const sysLinkKey = (hash: string) => `${REDIS_SYS_KEYS.DOWNLOAD_LINK.LINK}:${hash}` as const;
const sysLinkIdKey = (linkId: string) =>
  `${REDIS_SYS_KEYS.DOWNLOAD_LINK.LINK_ID}:${linkId}` as const;
const sysCredSetKey = (credential: DownloadLinkCredential) =>
  `${REDIS_SYS_KEYS.DOWNLOAD_LINK.CRED_LINKS}:${credentialKey(credential)}` as const;

const cluster = <T>(fn: string, op: () => Promise<T>) =>
  boundedClusterCall(`downloadLink.${fn}`, op);

/** A provider link has no cap, so it is never over. */
export const isOverFetchCap = (link: StoredDownloadLink, fetches: number) =>
  !link.provider && !(fetches <= link.maxFetches);

function parseLink(raw: Record<string, string>): StoredDownloadLink | null {
  if (!raw?.linkId || !raw.expiresAt) return null;
  const userId = raw.onBehalfOfUserId ? Number(raw.onBehalfOfUserId) : null;
  return {
    credentialKind: raw.credentialKind === 'client' ? 'client' : 'apikey',
    credentialId: raw.credentialId,
    credentialEpoch: raw.credentialEpoch ?? '',
    onBehalfOfUserId: userId,
    provider: raw.provider || null,
    modelVersionId: Number(raw.modelVersionId),
    fileId: Number(raw.fileId),
    workflowId: raw.workflowId ?? '',
    linkId: raw.linkId,
    mintedAt: Number(raw.mintedAt),
    expiresAt: Number(raw.expiresAt),
    fetches: Number(raw.fetches ?? 0),
    maxFetches: Number(raw.maxFetches),
  };
}

/** Where the link `hash` is held: the cluster, else (during the fallback) sysRedis. */
async function findLink(
  hash: string
): Promise<{ link: StoredDownloadLink; store: 'cluster' | 'sys' } | null> {
  const link = parseLink(await cluster('read', () => redis.hGetAll<string>(linkKey(hash))));
  if (link) return { link, store: 'cluster' };
  if (!sysFallbackOpen()) return null;
  const old = parseLink(await withSysReadDeadline(sysRedis.hGetAll<string>(sysLinkKey(hash))));
  return old ? { link: old, store: 'sys' } : null;
}

const readLinkByHash = async (hash: string) => (await findLink(hash))?.link ?? null;

export async function createLink(
  input: Omit<
    StoredDownloadLink,
    'linkId' | 'fetches' | 'credentialKind' | 'credentialId' | 'credentialEpoch'
  > & {
    credential: DownloadLinkCredential;
  }
): Promise<{ id: string; linkId: string }> {
  const { credential, ...link } = input;
  const linkId = randomLinkToken();
  const secret = linkSecret();
  const id = secret ? deriveId(secret, linkId) : randomLinkToken();
  const hash = sha256(id);
  const fields: Record<string, string> = {
    credentialKind: credential.kind,
    credentialId: credential.id,
    credentialEpoch: credential.epoch ?? '',
    onBehalfOfUserId: link.onBehalfOfUserId == null ? '' : String(link.onBehalfOfUserId),
    provider: link.provider ?? '',
    modelVersionId: String(link.modelVersionId),
    fileId: String(link.fileId),
    workflowId: link.workflowId,
    linkId,
    mintedAt: String(link.mintedAt),
    expiresAt: String(link.expiresAt),
    fetches: '0',
    maxFetches: String(link.maxFetches),
  };
  // One key per write, the link hash first: every other key names it, so none can point at a link
  // that was never written. Each MULTI is on one key, so the hash and the set never lack a TTL.
  // A failure part way leaves a link that cannot be revoked by linkId or by its credential, until
  // it expires; the mint answers an error, so its URL is never handed out.
  await cluster('create.link', () =>
    redis.multi().hSet(linkKey(hash), fields).pExpireAt(linkKey(hash), link.expiresAt).exec()
  );
  await cluster('create.linkId', () =>
    redis.set(linkIdKey(linkId), hash, { PXAT: link.expiresAt })
  );
  await cluster('create.credSet', () =>
    redis
      .multi()
      .sAdd(credSetKey(credential), hash)
      .expire(credSetKey(credential), MAX_LINK_TTL_SECONDS)
      .exec()
  );
  // Without the secret a link's URL cannot be rebuilt, so there is nothing to reuse.
  if (secret)
    await cluster('create.reuse', () =>
      redis.set(reuseKey(credential, link.fileId, link), hash, { PXAT: link.expiresAt })
    );
  return { id, linkId };
}

/**
 * The live link a repeat mint should return, or null to mint a new one: same credential, file,
 * user and provider, at least `minRemainingMs` left, under the fetch cap, and an id the current
 * secret rebuilds.
 */
export async function findReusableLink({
  credential,
  fileId,
  onBehalfOfUserId,
  provider,
  now,
  minRemainingMs,
  maxExpiresAt,
}: {
  credential: DownloadLinkCredential;
  fileId: number;
  onBehalfOfUserId: number | null;
  provider: string | null;
  now: number;
  minRemainingMs: number;
  /** A repeat mint never returns a link that outlives the lifetime it asked for. */
  maxExpiresAt: number;
}): Promise<{ id: string; link: StoredDownloadLink } | null> {
  const secret = linkSecret();
  if (!secret) return null;
  const hash = await cluster('findReusable', () =>
    redis.get(reuseKey(credential, fileId, { onBehalfOfUserId, provider }))
  );
  if (!hash) return null;
  const link = await readLinkByHash(hash);
  if (
    !link ||
    link.credentialKind !== credential.kind ||
    link.credentialId !== credential.id ||
    link.credentialEpoch !== (credential.epoch ?? '') ||
    link.fileId !== fileId ||
    link.onBehalfOfUserId !== onBehalfOfUserId ||
    link.provider !== provider ||
    link.expiresAt - now < minRemainingMs ||
    link.expiresAt > maxExpiresAt ||
    isOverFetchCap(link, link.fetches + 1)
  )
    return null;
  // A rotated secret rebuilds a different id: mint fresh rather than hand back a dead URL.
  const id = deriveId(secret, link.linkId);
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(sha256(id), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { id, link };
}

// Counts a fetch only on a link that exists: a bare HINCRBY on a missing key would create one with
// no expiry.
const COUNT_FETCH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
return redis.call('HINCRBY', KEYS[1], 'fetches', 1)
`;

/** The link `id`, without counting a fetch; null if absent. */
export const readLink = (id: string) => readLinkByHash(sha256(id));

/** Counts one fetch of the link `id` and returns it with its fetch number, or null if absent. */
export async function recordFetch(
  id: string
): Promise<{ link: StoredDownloadLink; fetch: number } | null> {
  const hash = sha256(id);
  let fetch = Number(
    await cluster('recordFetch', () =>
      redis.eval(COUNT_FETCH_SCRIPT, { keys: [linkKey(hash)], arguments: [] })
    )
  );
  if (!(fetch > 0) && sysFallbackOpen())
    fetch = Number(
      await sysRedis.eval(COUNT_FETCH_SCRIPT, { keys: [sysLinkKey(hash)], arguments: [] })
    );
  if (!(fetch > 0)) return null;
  const link = await readLinkByHash(hash);
  return link ? { link, fetch } : null;
}

const DEL_IF_EQUALS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** Deletes a link's keys one at a time, the hash first: once it is gone the link no longer opens. */
async function deleteLink(hash: string, link: StoredDownloadLink, store: 'cluster' | 'sys') {
  const credential = { kind: link.credentialKind, id: link.credentialId };
  if (store === 'sys') {
    await sysRedis.del(sysLinkKey(hash));
    await sysRedis.del(sysLinkIdKey(link.linkId));
    await sysRedis.sRem(sysCredSetKey(credential), hash);
    return;
  }
  await cluster('delete.link', () => redis.del(linkKey(hash)));
  await cluster('delete.linkId', () => redis.del(linkIdKey(link.linkId)));
  await cluster('delete.credSet', () => redis.sRem(credSetKey(credential), hash));
  await cluster('delete.reuse', () =>
    redis.eval(DEL_IF_EQUALS_SCRIPT, {
      keys: [reuseKey(credential, link.fileId, link)],
      arguments: [hash],
    })
  );
}

/** Revokes one link, only for the credential that minted it. */
export async function revokeLink(credential: DownloadLinkCredential, linkId: string) {
  let hash = await cluster('revoke.linkId', () => redis.get(linkIdKey(linkId)));
  if (!hash && sysFallbackOpen())
    hash = await withSysReadDeadline(sysRedis.get(sysLinkIdKey(linkId)));
  if (!hash) return false;
  const found = await findLink(hash);
  if (
    !found ||
    found.link.credentialKind !== credential.kind ||
    found.link.credentialId !== credential.id
  )
    return false;
  await deleteLink(hash, found.link, found.store);
  return true;
}

/** Revokes every link a credential minted. */
export async function revokeCredentialLinks(credential: DownloadLinkCredential) {
  const hashes = new Set(
    await cluster('revokeAll.members', () => redis.sMembers<string>(credSetKey(credential)))
  );
  const sysHashes = sysFallbackOpen()
    ? await withSysReadDeadline(sysRedis.sMembers<string>(sysCredSetKey(credential)))
    : [];
  for (const hash of sysHashes) hashes.add(hash);
  for (const hash of hashes) {
    const found = await findLink(hash);
    if (found) await deleteLink(hash, found.link, found.store);
    else await cluster('revokeAll.link', () => redis.del(linkKey(hash)));
  }
  await cluster('revokeAll.credSet', () => redis.del(credSetKey(credential)));
  if (sysFallbackOpen()) await sysRedis.del(sysCredSetKey(credential));
  return hashes.size;
}

const listed = (list: string[], id: string) => list.some((entry) => entry.trim() === id);

/** On `DOWNLOAD_LINK_CLIENT_IDS` / `DOWNLOAD_LINK_API_KEY_IDS`. */
export const isAllowlistedMinter = (credential: DownloadLinkCredential) =>
  credential.id !== '' &&
  listed(
    credential.kind === 'client' ? env.DOWNLOAD_LINK_CLIENT_IDS : env.DOWNLOAD_LINK_API_KEY_IDS,
    credential.id
  );

/** Also on a PUBLIC list: may mint links that name no user. */
export const mayMintPublicLinks = (credential: DownloadLinkCredential) =>
  isAllowlistedMinter(credential) &&
  listed(
    credential.kind === 'client'
      ? env.DOWNLOAD_LINK_PUBLIC_CLIENT_IDS
      : env.DOWNLOAD_LINK_PUBLIC_API_KEY_IDS,
    credential.id
  );

/** Also on `DOWNLOAD_LINK_PROVIDER_API_KEY_IDS`: may mint links a provider fetches as itself. */
export const mayMintProviderLinks = (credential: DownloadLinkCredential) =>
  credential.kind === 'apikey' &&
  isAllowlistedMinter(credential) &&
  listed(env.DOWNLOAD_LINK_PROVIDER_API_KEY_IDS, credential.id);

/**
 * Revokes the links of any allowlisted credential among `credentials`, for the paths that revoke
 * or rotate one. Best-effort: the use-time liveness check refuses them anyway (a rotation through
 * the link's `credentialEpoch`).
 */
export async function revokeLinksOfRevokedCredentials(credentials: DownloadLinkCredential[]) {
  for (const credential of credentials.filter(isAllowlistedMinter)) {
    try {
      await revokeCredentialLinks(credential);
    } catch (error) {
      logToAxiom({
        name: 'download-link',
        type: 'error',
        message: 'credential-revoke-failed',
        credentialKind: credential.kind,
        credentialId: credential.id,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Adds `count` to a fixed one-minute window and returns whether the window is still within
 * `limit`, with the seconds until it resets.
 */
export async function takeMintBudget(
  bucket: string,
  count: number,
  limit: number,
  now: number
): Promise<{ allowed: boolean; granted: number; retryAfterSeconds: number }> {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const key = `${REDIS_KEYS.DOWNLOAD_LINK.MINT_RATE}:${bucket}:${windowStart}` as const;
  // One atomic INCRBY per take, so concurrent takes never grant past the limit between them. A
  // failure or timeout throws, refusing the mint.
  const used = await takeClusterWindowCount('takeMintBudget', key, 120, { by: count });
  const before = used - count;
  return {
    allowed: used <= limit,
    granted: Math.min(count, Math.max(0, limit - before)),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000)),
  };
}
