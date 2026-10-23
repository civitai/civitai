/**
 * App Blocks — FORKABLE APPS, PR 3: starting a fork.
 *
 * `startAppFork` turns "Fork" on a parent's store page into the three things the App Assistant
 * page needs to create the user's copy:
 *
 *   1. a new block slug for the fork (`<parent>-fork-<4 hex>`, unique, a valid blockId);
 *   2. a SEED — the parent's LATEST APPROVED source, zipped with its files at the root, secrets,
 *      dependencies and build output left out, its manifest's `blockId` rewritten to the fork's
 *      slug, uploaded to the dedicated seed store and presigned for 10 minutes;
 *   3. a server-side FORK SESSION recording who forked what, at which commit.
 *
 * 🔴 THE FORK SESSION IS THE ONLY SOURCE OF A FORK'S PROVENANCE. When the fork's first version is
 * submitted, `submitVersion` calls {@link applyForkSessionToFirstPublishRequest}, which looks the
 * session up by the submitted slug AND the submitter, and only then calls
 * `setPublishRequestForkProvenance`. Nothing a client sends — no request field, no manifest key —
 * can name a parent. The forgery test in `app-fork-start.service.test.ts` pins it.
 *
 * 🔴 ONLY REVIEWED CODE. The seed is built from the parent's latest APPROVED publish request's
 * `forgejoCommitSha`: the commit the platform itself wrote on approve. Never a branch HEAD, which
 * an unreviewed push can move.
 *
 * 🔴 NOTHING ELSE IS INHERITED. This module writes no database row at all: no approvals, no
 * scopes, no goods catalog, no entitlements, no fee accruals. Paid goods stay in the fork's CODE
 * and can sell only after the fork's own publish review approves them. Pinned by the
 * "no database writes" test.
 *
 * The session lives in sysRedis (`REDIS_SYS_KEYS.BLOCKS.FORK_SESSION`) for 30 days — longer than
 * the sandbox service keeps an unused app (14 days) — so a fork published within its life gets
 * its "Forked from" credit. No migration: the provenance columns it feeds are #6637's, and every
 * write to them already tolerates their absence.
 */

import { createHash, randomBytes } from 'crypto';
import type { IncomingMessage } from 'http';
import JSZip from 'jszip';
import type { NextApiRequest } from 'next';
import { TRPCError } from '@trpc/server';

import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logToAxiom } from '~/server/logging/client';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';
import {
  FORKABLE_OFFSITE_MESSAGE,
  FORK_COMMIT_SHA_RE,
  readListingForkable,
  setPublishRequestForkProvenance,
} from '~/server/services/blocks/app-fork.service';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import {
  FORK_BUSY_MESSAGE,
  FORK_NOT_ALLOWED_MESSAGE,
  FORK_NO_APPROVED_VERSION_MESSAGE,
  FORK_PARENT_UNAVAILABLE_MESSAGE,
  FORK_RATE_LIMITED_MESSAGE,
  FORK_SETTING_DISABLED_MESSAGE,
  FORK_SOURCE_UNREADABLE_MESSAGE,
  FORK_START_LIMITS,
  FORK_TOO_LARGE_MESSAGE,
  FORK_UNAVAILABLE_HERE_MESSAGE,
} from '~/shared/constants/app-fork.constants';
import type { SessionUser } from '~/types/session';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** How long a fork session (and so a fork's claim to its parent) is kept. */
export const FORK_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The sandbox service's own seed caps (`SEED_MAX_BYTES`, `SEED_MAX_ENTRIES`). */
export const FORK_SEED_MAX_BYTES = 25 * 1024 * 1024;
export const FORK_SEED_MAX_FILES = 5000;

/** The sandbox service's rule for a seeded app (3–40 chars), which is also a blockId. */
export const FORK_SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const FORK_SUFFIX_LENGTH = '-fork-'.length + 4;
const SLUG_MAX = 40;
const SLUG_ATTEMPTS = 6;

const MANIFEST_PATH = 'block.manifest.json';

// ---------------------------------------------------------------------------
// The seed's contents
// ---------------------------------------------------------------------------

/** Top-level directories that hold dependencies or build output, never source. */
const BUILD_OUTPUT_DIRS = new Set([
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.vercel',
  '.cache',
  '.output',
  'coverage',
]);

const SSH_KEY_RE = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/;
const KEY_FILE_RE = /\.(pem|key|p12|pfx)$/i;
const CREDENTIAL_FILES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials']);

/**
 * Why `path` is left out of a fork's seed, or `null` to keep it. Secrets (`.env*`, keys,
 * credential files), git metadata, dependencies (`node_modules` at any depth) and top-level build
 * output. A superset of what the sandbox service itself skips.
 */
export function forkSeedExclusionReason(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (segments.some((s) => s === '.git')) return 'git';
  if (segments.some((s) => s.startsWith('.env'))) return 'env';
  if (segments.some((s) => s === 'node_modules')) return 'dependencies';
  if (segments.length > 1 && BUILD_OUTPUT_DIRS.has(segments[0])) return 'build-output';
  if (KEY_FILE_RE.test(base) || SSH_KEY_RE.test(base)) return 'key';
  if (CREDENTIAL_FILES.has(base)) return 'credentials';
  return null;
}

export type ForkSeedZip = {
  buffer: Buffer;
  sha256: string;
  /** Paths kept, in archive order. */
  files: string[];
  /** Paths left out. */
  excluded: string[];
};

/**
 * Build the seed archive from the parent's files: files at the archive ROOT (no wrapper
 * directory — the sandbox service extracts as-is into `/workspace/<fork slug>`), exclusions
 * dropped, and `block.manifest.json`'s `blockId` set to the fork's slug so the copy publishes as
 * a NEW app rather than as an update of the parent. Deterministic (sorted, zero timestamps).
 *
 * Throws {@link TRPCError} PRECONDITION_FAILED when there is no manifest to rewrite.
 */
export async function buildForkSeedZip(
  entries: Array<{ path: string; content: Buffer }>,
  forkSlug: string
): Promise<ForkSeedZip> {
  const kept: Array<{ path: string; content: Buffer }> = [];
  const excluded: string[] = [];
  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, '');
    if (!path || path.endsWith('/')) continue;
    if (forkSeedExclusionReason(path)) excluded.push(path);
    else kept.push({ path, content: entry.content });
  }
  const manifestIndex = kept.findIndex((f) => f.path === MANIFEST_PATH);
  if (manifestIndex < 0) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_SOURCE_UNREADABLE_MESSAGE });
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(kept[manifestIndex].content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_SOURCE_UNREADABLE_MESSAGE });
  }
  manifest.blockId = forkSlug;
  kept[manifestIndex] = {
    path: MANIFEST_PATH,
    content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
  };
  kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const zip = new JSZip();
  for (const f of kept) zip.file(f.path, f.content, { date: new Date(0), createFolders: false });
  const buffer = Buffer.from(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  );
  return {
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    files: kept.map((f) => f.path),
    excluded,
  };
}

/** The sandbox service's cap on a seed's uncompressed size (`SEED_MAX_UNCOMPRESSED_BYTES`). */
export const FORK_SEED_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/**
 * Read every file out of the parent's bundle. The bundle is the platform's own reconstruction of
 * an approved commit, so it already passed the publish caps; the running total here only stops a
 * copy the sandbox service would refuse from being built at all.
 */
async function readZipFiles(buffer: Buffer): Promise<Array<{ path: string; content: Buffer }>> {
  const zip = await JSZip.loadAsync(buffer);
  const out: Array<{ path: string; content: Buffer }> = [];
  let total = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const content = await entry.async('nodebuffer');
    total += content.length;
    if (total > FORK_SEED_MAX_UNCOMPRESSED_BYTES) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_TOO_LARGE_MESSAGE });
    }
    out.push({ path, content });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The fork's slug
// ---------------------------------------------------------------------------

/** `<parent>-fork-<hex4>`, the parent part cut so the whole is at most 40 characters. */
export function forkSlugFor(parentSlug: string, hex4: string): string {
  let base = parentSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, SLUG_MAX - FORK_SUFFIX_LENGTH)
    .replace(/-+$/, '');
  if (!base) base = 'app';
  return `${base}-fork-${hex4}`;
}

/** Whether `slug` is valid for both the sandbox service and a block (no `--` runs). */
export function isValidForkSlug(slug: string): boolean {
  return FORK_SLUG_RE.test(slug) && !slug.includes('--');
}

function forkSessionKey(forkSlug: string) {
  return `${REDIS_SYS_KEYS.BLOCKS.FORK_SESSION}:${forkSlug}` as const;
}

/** Whether any app, store listing or publish request already holds `slug`. */
async function slugTakenInDb(slug: string): Promise<boolean> {
  const { dbRead } = await import('~/server/db/client');
  const [block, listing, request] = await Promise.all([
    dbRead.appBlock.findFirst({ where: { blockId: slug }, select: { id: true } }),
    dbRead.appListing.findFirst({ where: { slug }, select: { id: true } }),
    dbRead.appBlockPublishRequest.findFirst({ where: { slug }, select: { id: true } }),
  ]);
  return !!(block || listing || request);
}

// ---------------------------------------------------------------------------
// The fork session
// ---------------------------------------------------------------------------

export type ForkSeed = { url: string; sha256: string; bytes: number };

export type ForkSession = {
  forkSlug: string;
  userId: number;
  parentAppBlockId: string;
  parentCommitSha: string;
  parentListingId: string;
  parentName: string;
  /** `null` while the seed is still being built (the record is the slug's reservation). */
  seed: ForkSeed | null;
  /** When the seed URL stops working. */
  seedExpiresAt: string | null;
  createdAt: string;
};

function parseSession(raw: string | null | undefined): ForkSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<ForkSession>;
    if (
      typeof s.forkSlug !== 'string' ||
      typeof s.userId !== 'number' ||
      typeof s.parentAppBlockId !== 'string' ||
      typeof s.parentCommitSha !== 'string' ||
      !FORK_COMMIT_SHA_RE.test(s.parentCommitSha) ||
      typeof s.parentListingId !== 'string' ||
      typeof s.parentName !== 'string'
    )
      return null;
    return {
      forkSlug: s.forkSlug,
      userId: s.userId,
      parentAppBlockId: s.parentAppBlockId,
      parentCommitSha: s.parentCommitSha,
      parentListingId: s.parentListingId,
      parentName: s.parentName,
      seed: s.seed ?? null,
      seedExpiresAt: s.seedExpiresAt ?? null,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
    };
  } catch {
    return null;
  }
}

/** Read the fork session for `forkSlug`, whoever it belongs to. */
export async function readForkSession(forkSlug: string): Promise<ForkSession | null> {
  if (!isValidForkSlug(forkSlug)) return null;
  const raw = await withSysReadDeadline(sysRedis.get(forkSessionKey(forkSlug)));
  return parseSession(raw);
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

/**
 * Count one fork start against each of the user's windows ({@link FORK_START_LIMITS}). Refuses
 * with TOO_MANY_REQUESTS past any cap, and FAILS CLOSED (SERVICE_UNAVAILABLE) when the counter
 * cannot be read: every start builds and uploads a copy of an app's source.
 */
async function consumeForkStart(userId: number): Promise<void> {
  for (const { windowSeconds, max } of FORK_START_LIMITS) {
    const key = `${REDIS_SYS_KEYS.BLOCKS.FORK_RATE_LIMIT}:${userId}:${windowSeconds}` as const;
    let count: number;
    try {
      const result = await withSysReadDeadline(
        sysRedis.multi().set(key, '0', { NX: true, EX: windowSeconds }).incr(key).exec()
      );
      count = Number((result as unknown[] | null)?.[1]);
    } catch {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: FORK_BUSY_MESSAGE });
    }
    if (!Number.isFinite(count)) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: FORK_BUSY_MESSAGE });
    }
    if (count > max) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: FORK_RATE_LIMITED_MESSAGE });
    }
  }
}

// ---------------------------------------------------------------------------
// startAppFork
// ---------------------------------------------------------------------------

export type ForkStartResult = {
  forkSlug: string;
  parentName: string;
  parentListingId: string;
  seed: ForkSeed;
};

export type StartAppForkInput = {
  user: SessionUser;
  listingId: string;
  /** The viewer's store scope; the parent must be a listing this viewer could open. */
  scope: StoreVisibilityScope;
  /** Whether this request may see mature listings (a red-capable host). */
  redCapable: boolean;
  /** The request, for the App Assistant feature gate. */
  req?: NextApiRequest | IncomingMessage;
};

/**
 * Start a fork of the listing `listingId` for `user`.
 *
 * Refuses, in order (each with its exact message, pinned by the tests):
 *   - an account App Assistant refuses (banned, muted, not onboarded, unverified email) or a
 *     user without App Assistant → FORBIDDEN, App Assistant's own message;
 *   - the `app-blocks-fork` rollout flag off → FORBIDDEN;
 *   - no seed store in this environment → PRECONDITION_FAILED;
 *   - a parent that is not PUBLICLY visible in the store (missing, unapproved, moderator-removed,
 *     restricted to a cohort, private, mature on this host) → NOT_FOUND, indistinguishable from a
 *     missing one;
 *   - a parent whose author has not opted in → FORBIDDEN;
 *   - an off-site parent (no source here) → PRECONDITION_FAILED;
 *   - a parent with no approved commit → PRECONDITION_FAILED;
 *   - over the per-user rate limit → TOO_MANY_REQUESTS.
 */
export async function startAppFork(input: StartAppForkInput): Promise<ForkStartResult> {
  const { user } = input;

  const { getAppAssistantRefusal } = await import(
    '~/server/services/app-assistant/app-assistant.service'
  );
  const refusal = await getAppAssistantRefusal({ user, req: input.req });
  if (refusal) throw new TRPCError({ code: 'FORBIDDEN', message: refusal.error });

  const { isAppBlocksForkEnabled } = await import('~/server/services/app-blocks-flag');
  if (!(await isAppBlocksForkEnabled({ user }))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORK_SETTING_DISABLED_MESSAGE });
  }

  const {
    forkSeedStoreConfig,
    forkSeedKey,
    stageForkSeed,
    isAcceptableSeedUrl,
    FORK_SEED_PRESIGN_TTL_SECONDS,
  } = await import('~/utils/fork-seed-s3');
  const store = forkSeedStoreConfig();
  if (!store) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_UNAVAILABLE_HERE_MESSAGE });
  }

  // 🔴 PUBLICLY VISIBLE, not merely visible to this viewer: floor `public` whoever asks, so a
  // moderator cannot fork a listing restricted to moderators or testers, and a moderator-removed
  // or unapproved listing reads as missing. The viewer's own scope still applies on top.
  const { getStoreVisibleListingSummary } = await import(
    '~/server/services/blocks/app-listing.service'
  );
  // MUTANT (do not merge): the visibility gate fails open.
  const parent = (await getStoreVisibleListingSummary(
    { id: input.listingId },
    { redCapable: input.redCapable, scope: input.scope, floor: 'public' }
  )) ?? { id: input.listingId, slug: '', name: 'unchecked' };
  if (!parent) {
    throw new TRPCError({ code: 'NOT_FOUND', message: FORK_PARENT_UNAVAILABLE_MESSAGE });
  }

  const { dbRead } = await import('~/server/db/client');
  const forkable = await readListingForkable(parent.id, dbRead);
  if (!forkable.forkable) {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORK_NOT_ALLOWED_MESSAGE });
  }

  const listing = await dbRead.appListing.findFirst({
    where: { id: parent.id },
    select: { kind: true, appBlock: { select: { id: true, blockId: true } } },
  });
  const parentBlock = listing?.appBlock ?? null;
  if (listing?.kind !== 'onsite' || !parentBlock) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORKABLE_OFFSITE_MESSAGE });
  }

  // The latest APPROVED commit — the sha the platform wrote on approve. Never a branch HEAD.
  const approved = await dbRead.appBlockPublishRequest.findFirst({
    where: { appBlockId: parentBlock.id, status: 'approved', forgejoCommitSha: { not: null } },
    orderBy: [{ reviewedAt: 'desc' }, { submittedAt: 'desc' }],
    select: { forgejoCommitSha: true },
  });
  const parentCommitSha = approved?.forgejoCommitSha ?? null;
  if (!parentCommitSha || !FORK_COMMIT_SHA_RE.test(parentCommitSha)) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_NO_APPROVED_VERSION_MESSAGE });
  }

  await consumeForkStart(user.id);

  // Reserve a slug: free in the database, then claimed atomically by the session's SET NX.
  const now = new Date();
  const base: Omit<ForkSession, 'forkSlug'> = {
    userId: user.id,
    parentAppBlockId: parentBlock.id,
    parentCommitSha,
    parentListingId: parent.id,
    parentName: parent.name,
    seed: null,
    seedExpiresAt: null,
    createdAt: now.toISOString(),
  };
  let forkSlug: string | null = null;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS && !forkSlug; attempt++) {
    const candidate = forkSlugFor(parentBlock.blockId, randomBytes(2).toString('hex'));
    if (!isValidForkSlug(candidate) || (await slugTakenInDb(candidate))) continue;
    const claimed = await withSysReadDeadline(
      sysRedis.set(forkSessionKey(candidate), JSON.stringify({ ...base, forkSlug: candidate }), {
        NX: true,
        EX: FORK_SESSION_TTL_SECONDS,
      })
    ).catch(() => null);
    if (claimed) forkSlug = candidate;
  }
  if (!forkSlug) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: FORK_BUSY_MESSAGE });
  }

  try {
    const { reconstructBundleFromForgejo } = await import('./publish-request.service');
    const bundle = await reconstructBundleFromForgejo(parentBlock.blockId, parentCommitSha);
    const seedZip = await buildForkSeedZip(await readZipFiles(bundle), forkSlug);
    if (seedZip.buffer.length > FORK_SEED_MAX_BYTES || seedZip.files.length > FORK_SEED_MAX_FILES) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_TOO_LARGE_MESSAGE });
    }

    const url = await stageForkSeed(forkSeedKey(forkSlug, seedZip.sha256), seedZip.buffer);
    if (!isAcceptableSeedUrl(url, store.endpoint)) {
      // A misconfigured store (http, a port, another host) would be refused by the sandbox
      // service anyway; refusing here keeps the reason in our logs, not the user's error.
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORK_UNAVAILABLE_HERE_MESSAGE });
    }
    const seed: ForkSeed = { url, sha256: seedZip.sha256, bytes: seedZip.buffer.length };
    const session: ForkSession = {
      ...base,
      forkSlug,
      seed,
      seedExpiresAt: new Date(now.getTime() + FORK_SEED_PRESIGN_TTL_SECONDS * 1000).toISOString(),
    };
    await withSysReadDeadline(
      sysRedis.set(forkSessionKey(forkSlug), JSON.stringify(session), {
        EX: FORK_SESSION_TTL_SECONDS,
      })
    );
    return { forkSlug, parentName: parent.name, parentListingId: parent.id, seed };
  } catch (err) {
    // Release the reservation: nothing will ever be created under it.
    await withSysReadDeadline(sysRedis.del(forkSessionKey(forkSlug))).catch(() => undefined);
    if (err instanceof TRPCError) throw err;
    logToAxiom({
      name: 'app-fork-start-failed',
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: FORK_SOURCE_UNREADABLE_MESSAGE });
  }
}

// ---------------------------------------------------------------------------
// Reading a session back (the App Assistant page)
// ---------------------------------------------------------------------------

export type ForkSessionView = {
  forkSlug: string;
  parentName: string;
  parentListingId: string;
  /** `null` once the seed URL has expired: the page offers a fresh fork instead. */
  seed: ForkSeed | null;
};

/**
 * The fork session `forkSlug`, for its OWNER only — anyone else (and a missing or malformed
 * session) gets `null`, so a slug cannot be used to read another user's seed URL.
 */
export async function getForkSessionForUser(args: {
  userId: number;
  forkSlug: string;
  now?: Date;
}): Promise<ForkSessionView | null> {
  const session = await readForkSession(args.forkSlug);
  if (!session || session.userId !== args.userId) return null;
  const now = (args.now ?? new Date()).getTime();
  const live =
    session.seed && session.seedExpiresAt && Date.parse(session.seedExpiresAt) > now
      ? session.seed
      : null;
  return {
    forkSlug: session.forkSlug,
    parentName: session.parentName,
    parentListingId: session.parentListingId,
    seed: live,
  };
}

// ---------------------------------------------------------------------------
// Provenance on the fork's first publish request
// ---------------------------------------------------------------------------

/**
 * Called by `submitVersion` for a FIRST version (no block yet holds `slug`): when a fork session
 * for `slug` exists AND belongs to the submitter, record its parent on the new request.
 *
 * 🔴 THE SESSION IS THE ONLY INPUT. The request's manifest is never read here, and there is no
 * parameter a client could fill: a slug with no session, or another user's session, records
 * nothing.
 *
 * BEST-EFFORT, NEVER THROWS: provenance is attribution and must not fail a submit. A missing
 * column (the #6637 migration not applied) is silent; anything else is logged.
 */
export async function applyForkSessionToFirstPublishRequest(args: {
  publishRequestId: string;
  slug: string;
  submittedByUserId: number;
}): Promise<boolean> {
  try {
    const session = await readForkSession(args.slug);
    if (!session || session.userId !== args.submittedByUserId) return false;
    const { dbWrite } = await import('~/server/db/client');
    return await setPublishRequestForkProvenance(dbWrite, {
      publishRequestId: args.publishRequestId,
      forkOfAppBlockId: session.parentAppBlockId,
      forkOfCommitSha: session.parentCommitSha,
    });
  } catch (err) {
    if (!isMissingColumnError(err)) {
      logToAxiom({
        name: 'app-fork-session-provenance-failed',
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => null);
    }
    return false;
  }
}
