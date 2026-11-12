/**
 * App Blocks SOURCE REPOS — `civitai-apps-src/<slug>` on the platform git host: the git history of
 * a forked or App Assistant app, which its developer can `civitai app pull` and `git push`.
 *
 * Not a build input and not a way to submit: no push webhook is attached, the push webhook's org
 * gate refuses this org (`git-push.ts`), and builds read only the platform's own snapshot in
 * `civitai-apps/<slug>`.
 *
 * Access ({@link resolveSourceRepoAccess}) mirrors the build repo's: the app block's owner and its
 * accepted collaborators once a block is bound to the repo, and before that the repo's owner (the
 * user who forked or built it).
 *
 * 🔴 Off until migration `20270105120000_app_source_repos` is applied by hand: every read treats a
 * missing table as "no source repo" ({@link readSourceRepo}).
 */

import JSZip from 'jszip';
import type { SandboxClient } from '@civitai/app-assistant';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  ASSISTANT_AUTHOR,
  ASSISTANT_BRANCH,
  PLATFORM_AUTHOR,
  SOURCE_MAIN_BRANCH,
  SOURCE_SLUG_RE,
  SourceFilesError,
  approvedSeedCommitMessage,
  assistantCommitMessage,
  forkSeedCommitMessage,
  planAssistantCommit,
  planReplaceCommit,
  sourceFilesFromExport,
  treeFromMap,
  treeOf,
  type BlobTree,
  type ForkLineage,
  type SourceFile,
} from '~/server/services/blocks/app-source-repo.plan';
import { isMissingTableError } from '~/server/services/blocks/app-access.service';
import { FORGEJO_SOURCE_ORG } from '~/shared/constants/app-source-repo.constants';

export type SourceRepoOrigin = 'fork' | 'assistant' | 'backfill';

export type SourceRepoRow = {
  slug: string;
  ownerUserId: number;
  appBlockId: string | null;
  origin: SourceRepoOrigin;
  forkedFromAppBlockId: string | null;
  forkedFromCommitSha: string | null;
  assistantTree: BlobTree | null;
  lastAssistantCommitSha: string | null;
  lastAssistantBranch: string | null;
};

/** `available: false` ⇒ the manual-apply table is missing, and the feature is off. */
export type SourceRepoRead = { available: boolean; row: SourceRepoRow | null };

const log = (type: 'info' | 'warning' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ name: 'app-source-repo', type, message, ...data }, 'webhooks').catch(
    () => undefined
  );

/**
 * Read a slug's source-repo row. A missing table reads as `{ available: false }` (the feature is
 * off); any other failure propagates.
 */
export async function readSourceRepo(
  slug: string,
  db: Pick<typeof dbRead, '$queryRaw'> = dbWrite
): Promise<SourceRepoRead> {
  if (!SOURCE_SLUG_RE.test(slug)) return { available: true, row: null };
  try {
    const rows = (await db.$queryRaw`SELECT
        "slug", "owner_user_id" AS "ownerUserId", "app_block_id" AS "appBlockId", "origin",
        "forked_from_app_block_id" AS "forkedFromAppBlockId",
        "forked_from_commit_sha" AS "forkedFromCommitSha",
        "assistant_tree" AS "assistantTree",
        "last_assistant_commit_sha" AS "lastAssistantCommitSha",
        "last_assistant_branch" AS "lastAssistantBranch"
      FROM "app_source_repos" WHERE "slug" = ${slug} LIMIT 1`) as SourceRepoRow[];
    return { available: true, row: rows[0] ?? null };
  } catch (err) {
    if (isMissingTableError(err)) return { available: false, row: null };
    throw err;
  }
}

/** Insert a row unless the slug already has one; true when this call inserted it. */
async function insertSourceRepo(row: {
  slug: string;
  ownerUserId: number;
  appBlockId: string | null;
  origin: SourceRepoOrigin;
  forkedFromAppBlockId: string | null;
  forkedFromCommitSha: string | null;
  assistantTree: BlobTree;
  lastAssistantCommitSha: string | null;
}): Promise<boolean> {
  const count = Number(
    await dbWrite.$executeRaw`INSERT INTO "app_source_repos"
        ("slug", "owner_user_id", "app_block_id", "origin", "forked_from_app_block_id",
         "forked_from_commit_sha", "assistant_tree", "last_assistant_commit_sha",
         "last_assistant_branch")
      VALUES (${row.slug}, ${row.ownerUserId}, ${row.appBlockId}, ${row.origin},
              ${row.forkedFromAppBlockId}, ${row.forkedFromCommitSha},
              ${JSON.stringify(row.assistantTree)}::jsonb, ${row.lastAssistantCommitSha},
              ${row.lastAssistantCommitSha ? SOURCE_MAIN_BRANCH : null})
      ON CONFLICT ("slug") DO NOTHING`
  );
  return count === 1;
}

async function recordAssistantSave(
  slug: string,
  tree: BlobTree,
  sha: string | null,
  branch: string
): Promise<void> {
  await dbWrite.$executeRaw`UPDATE "app_source_repos"
      SET "assistant_tree" = ${JSON.stringify(tree)}::jsonb,
          "last_assistant_commit_sha" = ${sha},
          "last_assistant_branch" = ${branch},
          "updated_at" = now()
    WHERE "slug" = ${slug}`;
}

/** Bind an unbound row to the app block its owner now has. Write-once. */
async function bindSourceRepo(slug: string, appBlockId: string): Promise<void> {
  await dbWrite.$executeRaw`UPDATE "app_source_repos"
      SET "app_block_id" = ${appBlockId}, "updated_at" = now()
    WHERE "slug" = ${slug} AND "app_block_id" IS NULL`;
}

type BlockForAccess = { id: string; blockId: string; app: { userId: number } | null };

async function findBlockBySlug(slug: string): Promise<BlockForAccess | null> {
  return (await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: { id: true, blockId: true, app: { select: { userId: true } } },
  })) as BlockForAccess | null;
}

async function findBlockById(id: string): Promise<BlockForAccess | null> {
  return (await dbRead.appBlock.findUnique({
    where: { id },
    select: { id: true, blockId: true, app: { select: { userId: true } } },
  })) as BlockForAccess | null;
}

/** Whether `userId` may edit `block`, by the gate the build repo's own procs use. */
async function hasBlockEditAccess(block: BlockForAccess, userId: number): Promise<boolean> {
  const { assertAppEditAccess } = await import('~/server/services/blocks/app-access.service');
  try {
    await assertAppEditAccess({ appBlockId: block.id, ownerUserId: block.app?.userId, userId });
    return true;
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') return false;
    throw err;
  }
}

/**
 * The block whose owner and collaborators decide access to a source repo, binding the row to it
 * the first time a block under the slug is the repo owner's: the block's owner is the repo's
 * owner, or the repo's owner filed a version of that block (so a block that changed hands since,
 * by an ownership transfer, still binds, and access moves with it). A block under the slug that
 * the repo's owner never had is not bound: someone else took the slug, the repo holds its own
 * owner's code, and the block's owner must not reach it.
 */
async function governingBlock(row: SourceRepoRow): Promise<BlockForAccess | null> {
  if (row.appBlockId) return findBlockById(row.appBlockId);
  const block = await findBlockBySlug(row.slug);
  if (!block) return null;
  const theirs =
    block.app?.userId === row.ownerUserId ||
    !!(await dbRead.appBlockPublishRequest.findFirst({
      where: { appBlockId: block.id, submittedByUserId: row.ownerUserId },
      select: { id: true },
    }));
  if (!theirs) return null;
  await bindSourceRepo(row.slug, block.id);
  return block;
}

export type SourceRepoAccess =
  | { ok: true; row: SourceRepoRow; role: 'owner' | 'editor' }
  | { ok: false; reason: 'none' | 'forbidden' | 'unavailable' };

/**
 * May `userId` use the source repo of `slug`?
 *   - a row bound to an app block (`app_block_id`): exactly the block's edit gate
 *     (`assertAppEditAccess`: the owner, or an ACCEPTED collaborator; no moderator bypass), so an
 *     ownership transfer or a seat removal moves access with it, and the row's own owner is ignored;
 *   - an unbound row: its owner only.
 * The caller still refuses a banned account and one that has not accepted the developer terms, as
 * the build repo's procs do.
 *
 * `none` covers both "no such repo" and "the table is missing"; `forbidden` is a repo the caller
 * may not use. Callers answer both the same way, so a slug is not an oracle.
 */
export async function resolveSourceRepoAccess(args: {
  slug: string;
  userId: number;
}): Promise<SourceRepoAccess> {
  const read = await readSourceRepo(args.slug);
  if (!read.available) return { ok: false, reason: 'unavailable' };
  const row = read.row;
  if (!row) return { ok: false, reason: 'none' };
  const block = await governingBlock(row);
  if (row.appBlockId && !block) return { ok: false, reason: 'forbidden' };
  if (block) {
    if (!(await hasBlockEditAccess(block, args.userId))) return { ok: false, reason: 'forbidden' };
    return { ok: true, row, role: block.app?.userId === args.userId ? 'owner' : 'editor' };
  }
  return row.ownerUserId === args.userId
    ? { ok: true, row, role: 'owner' }
    : { ok: false, reason: 'forbidden' };
}

/**
 * Whether `userId` may CREATE a source repo for `slug`: not when an app block under the slug is
 * someone else's to edit, and not when another account's first version of it waits for review.
 * Returns the block to bind to, when the caller may edit it.
 */
async function creationGate(
  slug: string,
  userId: number
): Promise<{ ok: true; block: BlockForAccess | null } | { ok: false }> {
  const block = await findBlockBySlug(slug);
  if (block) return (await hasBlockEditAccess(block, userId)) ? { ok: true, block } : { ok: false };
  const othersPending = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug, status: 'pending', submittedByUserId: { not: userId } },
    select: { id: true },
  });
  return othersPending ? { ok: false } : { ok: true, block: null };
}

// Covers a sandbox export plus a commit at the git host's commit timeout; the holder releases it.
const LOCK_TTL_SECONDS = 180;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` holding the slug's writer lock, or return `null` when it stays held for 30 s. */
async function withSourceRepoLock<T>(slug: string, fn: () => Promise<T>): Promise<T | null> {
  const key = `${REDIS_SYS_KEYS.BLOCKS.SOURCE_REPO_LOCK}:${slug}` as const;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const got = await sysRedis.set(key, token, { NX: true, EX: LOCK_TTL_SECONDS });
    if (got) break;
    if (Date.now() >= deadline) return null;
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock: one that outlived its TTL may be another writer's by now.
    const held = await sysRedis.get(key).catch(() => null);
    if (held === token) await sysRedis.del(key).catch(() => undefined);
  }
}

/**
 * For `civitai app pull` (`blocks.getMyForgejoCloneInfo`): when `userId` may use the source repo
 * of `slug`, grant their platform git identity `write` on it (at least; never lowered, see
 * `addCollaborator`) and return its token-less URL. `null` when there is no repo, the table is
 * missing, or the caller may not use it — one answer for all three.
 *
 * The caller has already refused a banned account and one without accepted developer terms.
 */
export async function grantSourceRepoForPull(args: {
  slug: string;
  userId: number;
  forgejoUsername: string;
}): Promise<{ sourceHttpUrl: string } | null> {
  const access = await resolveSourceRepoAccess({ slug: args.slug, userId: args.userId });
  if (!access.ok) return null;
  const [{ addCollaborator }, { env }, { sourceRepoHttpUrl }] = await Promise.all([
    import('~/server/services/blocks/forgejo.service'),
    import('~/env/server'),
    import('~/server/services/blocks/app-source-repo.plan'),
  ]);
  await addCollaborator({
    slug: args.slug,
    username: args.forgejoUsername,
    permission: 'write',
    org: FORGEJO_SOURCE_ORG,
  });
  return {
    sourceHttpUrl: sourceRepoHttpUrl(env.FORGEJO_PUBLIC_URL, FORGEJO_SOURCE_ORG, args.slug),
  };
}

export type EnsureSourceRepoResult =
  | { kind: 'created'; row: SourceRepoRow; seedSha: string | null }
  | { kind: 'exists'; row: SourceRepoRow }
  | { kind: 'unavailable' }
  | { kind: 'refused' };

/**
 * Create the source repo of `slug` for `ownerUserId`, seeded with `seed` when given. Idempotent:
 * a slug that already has a row is returned as it is, with no write of any kind (a re-run of the
 * backfill, a second fork start of the same slug). Call it holding the slug's lock.
 *
 * The seed's commit message is the caller's (`forkSeedCommitMessage` and siblings, built from
 * server-resolved values only). The tree the seed leaves is recorded as App Assistant's base, so
 * its first save commits only what it changed.
 */
async function ensureSourceRepoLocked(args: {
  slug: string;
  ownerUserId: number;
  origin: SourceRepoOrigin;
  seed?: { files: SourceFile[]; message: string };
  forkedFrom?: { appBlockId: string; commitSha: string };
}): Promise<EnsureSourceRepoResult> {
  if (!SOURCE_SLUG_RE.test(args.slug)) return { kind: 'refused' };
  const existing = await readSourceRepo(args.slug);
  if (!existing.available) return { kind: 'unavailable' };
  if (existing.row) return { kind: 'exists', row: existing.row };
  const gate = await creationGate(args.slug, args.ownerUserId);
  if (!gate.ok) return { kind: 'refused' };

  const forgejo = await import('~/server/services/blocks/forgejo.service');
  await forgejo.ensureSourceRepo(args.slug);
  const current = treeFromMap(
    await forgejo.listRepoTree(args.slug, SOURCE_MAIN_BRANCH, FORGEJO_SOURCE_ORG)
  );
  let tree = current;
  let seedSha: string | null = null;
  if (args.seed) {
    const plan = planReplaceCommit(current, args.seed.files);
    if (plan.operations.length) {
      const result = await forgejo.commitOperations({
        org: FORGEJO_SOURCE_ORG,
        slug: args.slug,
        branch: SOURCE_MAIN_BRANCH,
        operations: plan.operations,
        message: args.seed.message,
        author: PLATFORM_AUTHOR,
      });
      // A repo we just read the tree of moved under us: someone else is writing it. Leave it
      // unrecorded, so the next attempt (or the backfill) finds it again.
      if (result.kind === 'conflict') {
        log('warning', 'seed conflicted with a concurrent write', { slug: args.slug });
        return { kind: 'refused' };
      }
      seedSha = result.sha;
    }
    tree = treeOf(args.seed.files);
  }
  const row: SourceRepoRow = {
    slug: args.slug,
    ownerUserId: args.ownerUserId,
    appBlockId: gate.block?.id ?? null,
    origin: args.origin,
    forkedFromAppBlockId: args.forkedFrom?.appBlockId ?? null,
    forkedFromCommitSha: args.forkedFrom?.commitSha ?? null,
    assistantTree: tree,
    lastAssistantCommitSha: seedSha,
    lastAssistantBranch: seedSha ? SOURCE_MAIN_BRANCH : null,
  };
  const inserted = await insertSourceRepo({ ...row, assistantTree: tree });
  if (!inserted) {
    const raced = await readSourceRepo(args.slug);
    return raced.row ? { kind: 'exists', row: raced.row } : { kind: 'refused' };
  }
  log('info', 'created', { slug: args.slug, origin: args.origin, seedSha });
  return { kind: 'created', row, seedSha };
}

/** {@link ensureSourceRepoLocked}, holding the slug's lock. `busy` when it stayed held. */
export async function ensureAppSourceRepo(
  args: Parameters<typeof ensureSourceRepoLocked>[0]
): Promise<EnsureSourceRepoResult | { kind: 'busy' }> {
  return (
    (await withSourceRepoLock(args.slug, () => ensureSourceRepoLocked(args))) ?? {
      kind: 'busy',
    }
  );
}

/**
 * Fork start's hook: create the fork's source repo, seeded with exactly the files its sandbox
 * seed holds, the trailers naming the parent from the fork session (never the manifest).
 *
 * BEST-EFFORT, NEVER THROWS: a fork must start even when the git host or the table is not there;
 * the backfill creates a repo a failure here left out.
 */
export async function createForkSourceRepo(args: {
  forkSlug: string;
  userId: number;
  files: SourceFile[];
  lineage: ForkLineage & { parentAppBlockId: string };
}): Promise<EnsureSourceRepoResult | { kind: 'busy' } | { kind: 'failed' }> {
  try {
    return await ensureAppSourceRepo({
      slug: args.forkSlug,
      ownerUserId: args.userId,
      origin: 'fork',
      seed: { files: args.files, message: forkSeedCommitMessage(args.lineage) },
      forkedFrom: {
        appBlockId: args.lineage.parentAppBlockId,
        commitSha: args.lineage.parentCommitSha,
      },
    });
  } catch (err) {
    log('error', 'fork source repo failed', {
      slug: args.forkSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'failed' };
  }
}

export type AssistantSaveResult =
  | { kind: 'committed'; sha: string; branch: string; conflict: boolean }
  | { kind: 'unchanged' }
  | { kind: 'unavailable' }
  | { kind: 'refused' }
  | { kind: 'busy' }
  | { kind: 'not-running' }
  | { kind: 'too-large'; message: string };

const COMMIT_ATTEMPTS = 2;

/**
 * Commit one App Assistant save of `files` to `slug`'s source repo for `userId`, creating the repo
 * on the app's first save. Holds the slug's lock.
 *
 * 🔴 A developer push and an assistant save never lose either side: the save is planned against the
 * tree the platform last wrote for the assistant, and every operation names the blob it replaces,
 * so a file the developer changed makes the git host refuse the commit rather than overwrite it.
 * A refused save is committed to {@link ASSISTANT_BRANCH} instead.
 */
export async function saveAssistantFiles(args: {
  slug: string;
  userId: number;
  files: SourceFile[];
}): Promise<AssistantSaveResult> {
  if (!SOURCE_SLUG_RE.test(args.slug)) return { kind: 'refused' };
  const result = await withSourceRepoLock(args.slug, () => saveLocked(args));
  return result ?? { kind: 'busy' };
}

async function saveLocked(args: {
  slug: string;
  userId: number;
  files: SourceFile[];
}): Promise<AssistantSaveResult> {
  let access = await resolveSourceRepoAccess({ slug: args.slug, userId: args.userId });
  if (!access.ok && access.reason === 'unavailable') return { kind: 'unavailable' };
  if (!access.ok && access.reason === 'forbidden') return { kind: 'refused' };
  if (!access.ok) {
    const created = await ensureSourceRepoLocked({
      slug: args.slug,
      ownerUserId: args.userId,
      origin: 'assistant',
    });
    if (created.kind === 'unavailable') return { kind: 'unavailable' };
    if (created.kind === 'refused') return { kind: 'refused' };
    access = await resolveSourceRepoAccess({ slug: args.slug, userId: args.userId });
    if (!access.ok) return { kind: 'refused' };
  }
  const row = access.row;
  const { forgejoUsernameForUser } = await import(
    '~/server/services/blocks/dev-git-access.service'
  );
  const onBehalfOf = forgejoUsernameForUser(args.userId);
  const baseline = row.assistantTree ?? {};
  const plan = planAssistantCommit(baseline, args.files);
  if (!plan.operations.length) return { kind: 'unchanged' };

  const forgejo = await import('~/server/services/blocks/forgejo.service');
  const message = assistantCommitMessage(plan, onBehalfOf);
  const commit = async (branch: string, operations: typeof plan.operations, newBranch?: string) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      try {
        return await forgejo.commitOperations({
          org: FORGEJO_SOURCE_ORG,
          slug: args.slug,
          branch,
          ...(newBranch ? { newBranch } : {}),
          operations,
          message,
          author: ASSISTANT_AUTHOR,
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };

  const tree = treeOf(args.files);
  // Once a save has gone to the assistant's branch, later saves follow it there, so the branch
  // stays the assistant's COMPLETE history; a save planned against that tree and committed to
  // `main` would land on `main` without the files only the branch holds. They return to `main`
  // once `main` holds every file of the assistant's last save (the developer merged the branch).
  const onSideBranch =
    row.lastAssistantBranch === ASSISTANT_BRANCH &&
    !mainHolds(
      treeFromMap(await forgejo.listRepoTree(args.slug, SOURCE_MAIN_BRANCH, FORGEJO_SOURCE_ORG)),
      baseline
    );
  const onMain = onSideBranch
    ? ({ kind: 'conflict', status: 0 } as const)
    : await commit(SOURCE_MAIN_BRANCH, plan.operations);
  if (onMain.kind === 'committed') {
    await recordAssistantSave(args.slug, tree, onMain.sha, SOURCE_MAIN_BRANCH);
    return { kind: 'committed', sha: onMain.sha, branch: SOURCE_MAIN_BRANCH, conflict: false };
  }

  // `main` has a change of the developer's to a file this save also changes, or the assistant's
  // history is already on its branch: keep both.
  const branchHead = await forgejo.getBranchHead(FORGEJO_SOURCE_ORG, args.slug, ASSISTANT_BRANCH);
  const base = branchHead ? ASSISTANT_BRANCH : SOURCE_MAIN_BRANCH;
  const current = treeFromMap(await forgejo.listRepoTree(args.slug, base, FORGEJO_SOURCE_ORG));
  const side = planReplaceCommit(current, args.files);
  if (!side.operations.length) {
    await recordAssistantSave(args.slug, tree, branchHead ?? row.lastAssistantCommitSha, base);
    return { kind: 'unchanged' };
  }
  const onSide = await commit(base, side.operations, branchHead ? undefined : ASSISTANT_BRANCH);
  if (onSide.kind === 'conflict') {
    // The side branch moved between our read and our write: someone is writing it. Nothing was
    // lost (nothing was written); the next save tries again.
    log('warning', 'assistant branch moved during a save', { slug: args.slug });
    return { kind: 'busy' };
  }
  await recordAssistantSave(args.slug, tree, onSide.sha, ASSISTANT_BRANCH);
  log('info', 'assistant save went to its branch', { slug: args.slug, sha: onSide.sha });
  return { kind: 'committed', sha: onSide.sha, branch: ASSISTANT_BRANCH, conflict: true };
}

/** Whether `main` holds every file of `tree` with the same bytes. */
function mainHolds(main: BlobTree, tree: BlobTree): boolean {
  return Object.entries(tree).every(([path, sha]) => main[path] === sha);
}

/** The entries of a zip, files only. */
export async function zipEntries(buffer: Buffer | ArrayBuffer): Promise<SourceFile[]> {
  const zip = await JSZip.loadAsync(buffer);
  const out: SourceFile[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    out.push({ path, content: await entry.async('nodebuffer') });
  }
  return out;
}

/**
 * Commit the app `app` as it is now in `userId`'s App Assistant sandbox: read the app's export
 * from the sandbox service as the user (their own `sandbox` token), and save it
 * ({@link saveAssistantFiles}). Called by the page and by the server runner after the assistant
 * changed the app's files; never wakes a paused sandbox (`not-running`: the next save, made while
 * it runs, carries the change).
 */
export async function saveAssistantSourceFromSandbox(args: {
  userId: number;
  app: string;
}): Promise<AssistantSaveResult> {
  if (!SOURCE_SLUG_RE.test(args.app)) return { kind: 'refused' };
  // Off until the table exists: no sandbox call, no token minted.
  const read = await readSourceRepo(args.app);
  if (!read.available) return { kind: 'unavailable' };
  const { env } = await import('~/env/server');
  const baseUrl = env.APP_ASSISTANT_SANDBOX_URL;
  if (!baseUrl) return { kind: 'unavailable' };
  const { mintAppAssistantToken } = await import(
    '~/server/services/app-assistant/app-assistant.service'
  );
  const { createSandboxClient } = await import('@civitai/app-assistant');
  const client = createSandboxClient({
    baseUrl,
    getToken: async () => {
      const minted = await mintAppAssistantToken(args.userId, 'sandbox');
      if (!minted) throw new Error('no App Assistant consent');
      return minted.token;
    },
  });
  // The export is read HOLDING the slug's lock, as the commit is: two saves whose exports were read
  // in one order and committed in the other would let the older files commit last and roll the
  // newer save back (every blob it names would still match).
  const result = await withSourceRepoLock(args.app, () => exportAndSave(client, args));
  return result ?? { kind: 'busy' };
}

async function exportAndSave(
  client: SandboxClient,
  args: { userId: number; app: string }
): Promise<AssistantSaveResult> {
  const sandboxes = await client.list();
  const sandbox = sandboxes.find((s) => s.app === args.app && s.state === 'running');
  if (!sandbox) return { kind: 'not-running' };
  const exported = await client.exportApp(sandbox.name, args.app);
  let files: SourceFile[];
  try {
    files = sourceFilesFromExport(await zipEntries(await exported.arrayBuffer()), args.app);
  } catch (err) {
    if (err instanceof SourceFilesError) return { kind: 'too-large', message: err.message };
    throw err;
  }
  if (!files.length) return { kind: 'unchanged' };
  return saveLocked({ slug: args.app, userId: args.userId, files });
}

/**
 * Remove a banned user's collaborator rows from every source repo they could reach: the repos
 * they own (unbound rows) and those of every app block they own or hold an accepted seat on.
 * Revoking needs no identity (`forgejoUsernameForUser`), so it never provisions one. Best-effort
 * per repo; returns how many repos it revoked on.
 */
export async function revokeSourceRepoAccessForUser(userId: number): Promise<number> {
  let rows: Array<{ slug: string }>;
  try {
    rows = (await dbWrite.$queryRaw`SELECT sr."slug"
        FROM "app_source_repos" sr
        LEFT JOIN "app_blocks" ab ON ab."id" = sr."app_block_id"
        LEFT JOIN "OauthClient" oc ON oc."id" = ab."app_id"
        LEFT JOIN "app_listings" al ON al."app_block_id" = ab."id"
        LEFT JOIN "app_collaborators" c
          ON c."app_listing_id" = al."id" AND c."user_id" = ${userId} AND c."status" = 'accepted'
      WHERE (sr."app_block_id" IS NULL AND sr."owner_user_id" = ${userId})
         OR oc."userId" = ${userId}
         OR c."user_id" IS NOT NULL`) as Array<{ slug: string }>;
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
  const [{ forgejoUsernameForUser }, forgejo] = await Promise.all([
    import('~/server/services/blocks/dev-git-access.service'),
    import('~/server/services/blocks/forgejo.service'),
  ]);
  const username = forgejoUsernameForUser(userId);
  let revoked = 0;
  for (const { slug } of rows) {
    try {
      await forgejo.removeCollaborator({ slug, username, org: FORGEJO_SOURCE_ORG });
      revoked += 1;
    } catch (err) {
      log('error', 'ban revoke failed', {
        slug,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return revoked;
}

export type BackfillCandidate = {
  slug: string;
  ownerUserId: number;
  kind: 'approved-fork' | 'pending-fork';
  /** The commit the seed is read from (in the build repo of `seedRepoSlug`). */
  seedCommitSha: string;
  seedRepoSlug: string;
  lineage: (ForkLineage & { parentAppBlockId: string }) | null;
  version: string | null;
};

export type BackfillResult = {
  dryRun: boolean;
  candidates: number;
  /** Slugs that already had a source repo: the steady state on a re-run (no write at all). */
  existing: string[];
  /** Slugs created this run (or, under `dryRun`, that a real run would create). */
  created: Array<{ slug: string; kind: BackfillCandidate['kind']; from: string }>;
  skipped: Array<{ slug: string; reason: string }>;
  failed: Array<{ slug: string; error: string }>;
  /** Present when the table is missing: nothing was read or written. */
  unavailable?: true;
};

/**
 * The apps the backfill seeds: every app block that is a FORK (its server-written lineage,
 * `app_blocks.fork_of_*`), from its latest approved snapshot; and every fork still being built in
 * App Assistant (a live fork session, no block yet), from the parent's approved commit its sandbox
 * was seeded from. Read-only.
 *
 * Not here, by design: an App Assistant app that is not a fork. Nothing in the database marks one
 * (its files live only in the user's sandbox), and reading them would mean minting each user a
 * sandbox token and waking their sandboxes. Its repo is created by its next save instead.
 */
export async function listBackfillCandidates(): Promise<BackfillCandidate[]> {
  const out: BackfillCandidate[] = [];
  const forks = (await dbRead.$queryRaw`SELECT ab."id", ab."block_id" AS "slug",
        oc."userId" AS "ownerUserId",
        ab."fork_of_app_block_id" AS "parentAppBlockId", ab."fork_of_commit_sha" AS "parentCommitSha",
        parent."block_id" AS "parentSlug"
      FROM "app_blocks" ab
      JOIN "OauthClient" oc ON oc."id" = ab."app_id"
      LEFT JOIN "app_blocks" parent ON parent."id" = ab."fork_of_app_block_id"
      WHERE ab."fork_of_commit_sha" IS NOT NULL
      ORDER BY ab."block_id"`) as Array<{
    id: string;
    slug: string;
    ownerUserId: number;
    parentAppBlockId: string | null;
    parentCommitSha: string;
    parentSlug: string | null;
  }>;
  for (const fork of forks) {
    const approved = await dbRead.appBlockPublishRequest.findFirst({
      where: { appBlockId: fork.id, status: 'approved', forgejoCommitSha: { not: null } },
      orderBy: [{ reviewedAt: 'desc' }, { submittedAt: 'desc' }],
      select: { forgejoCommitSha: true, version: true },
    });
    if (!approved?.forgejoCommitSha) continue;
    out.push({
      slug: fork.slug,
      ownerUserId: fork.ownerUserId,
      kind: 'approved-fork',
      seedCommitSha: approved.forgejoCommitSha,
      seedRepoSlug: fork.slug,
      lineage:
        fork.parentSlug && fork.parentAppBlockId
          ? {
              parentSlug: fork.parentSlug,
              parentCommitSha: fork.parentCommitSha,
              parentAppBlockId: fork.parentAppBlockId,
            }
          : null,
      version: approved.version,
    });
  }

  const { readForkSession } = await import('~/server/services/blocks/app-fork-start.service');
  const prefix = `${REDIS_SYS_KEYS.BLOCKS.FORK_SESSION}:`;
  const seen = new Set(out.map((c) => c.slug));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (sysRedis as any).scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 });
  for await (const batch of stream as AsyncIterable<string[] | string>) {
    for (const key of Array.isArray(batch) ? batch : [batch]) {
      const forkSlug = key.slice(prefix.length);
      if (seen.has(forkSlug)) continue;
      const session = await readForkSession(forkSlug);
      if (!session || !session.seed) continue;
      // A fork that already has a block was listed above, or has no approved version yet.
      if (await findBlockBySlug(forkSlug)) continue;
      const parent = await findBlockById(session.parentAppBlockId);
      if (!parent) continue;
      seen.add(forkSlug);
      out.push({
        slug: forkSlug,
        ownerUserId: session.userId,
        kind: 'pending-fork',
        seedCommitSha: session.parentCommitSha,
        seedRepoSlug: parent.blockId,
        lineage: {
          parentSlug: parent.blockId,
          parentCommitSha: session.parentCommitSha,
          parentAppBlockId: session.parentAppBlockId,
        },
        version: null,
      });
    }
  }
  return out;
}

/** The files a candidate is seeded with. */
async function seedFilesFor(candidate: BackfillCandidate): Promise<SourceFile[]> {
  const { reconstructBundleFromForgejo } = await import(
    '~/server/services/blocks/publish-request.service'
  );
  const bundle = await reconstructBundleFromForgejo(
    candidate.seedRepoSlug,
    candidate.seedCommitSha
  );
  const entries = await zipEntries(bundle);
  if (candidate.kind === 'pending-fork') {
    // Exactly the seed the fork's sandbox started from (blockId rewritten, parent links removed).
    const { buildForkSeedZip } = await import('~/server/services/blocks/app-fork-start.service');
    return (await buildForkSeedZip(entries, candidate.slug)).entries;
  }
  return sourceFilesFromExport(entries, candidate.slug);
}

/**
 * ONE-OFF, RE-RUNNABLE: give every candidate ({@link listBackfillCandidates}) a source repo.
 *
 *  - IDEMPOTENT: a slug with a row is skipped before any git-host call, so a second run makes
 *    zero writes (`existing`).
 *  - DRY RUN: lists what a real run would create; reads the database and the fork sessions only
 *    (no git-host call, no write).
 *  - LOG-AND-CONTINUE: one failure is recorded and the walk goes on.
 */
export async function backfillAppSourceRepos(
  params: { dryRun?: boolean; limit?: number } = {}
): Promise<BackfillResult> {
  const dryRun = params.dryRun ?? false;
  const result: BackfillResult = {
    dryRun,
    candidates: 0,
    existing: [],
    created: [],
    skipped: [],
    failed: [],
  };
  const probe = await readSourceRepo('probe-slug');
  if (!probe.available) return { ...result, unavailable: true };

  const all = await listBackfillCandidates();
  const candidates = typeof params.limit === 'number' ? all.slice(0, params.limit) : all;
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    const from = `${candidate.seedRepoSlug}@${candidate.seedCommitSha}`;
    try {
      const existing = await readSourceRepo(candidate.slug);
      if (existing.row) {
        result.existing.push(candidate.slug);
        continue;
      }
      if (dryRun) {
        result.created.push({ slug: candidate.slug, kind: candidate.kind, from });
        continue;
      }
      const files = await seedFilesFor(candidate);
      const message =
        candidate.kind === 'pending-fork' && candidate.lineage
          ? forkSeedCommitMessage(candidate.lineage)
          : approvedSeedCommitMessage({
              version: candidate.version,
              approvedCommitSha: candidate.seedCommitSha,
              lineage: candidate.lineage,
            });
      const ensured = await ensureAppSourceRepo({
        slug: candidate.slug,
        ownerUserId: candidate.ownerUserId,
        origin: candidate.kind === 'pending-fork' ? 'fork' : 'backfill',
        seed: { files, message },
        ...(candidate.lineage
          ? {
              forkedFrom: {
                appBlockId: candidate.lineage.parentAppBlockId,
                commitSha: candidate.lineage.parentCommitSha,
              },
            }
          : {}),
      });
      if (ensured.kind === 'created')
        result.created.push({ slug: candidate.slug, kind: candidate.kind, from });
      else if (ensured.kind === 'exists') result.existing.push(candidate.slug);
      else result.skipped.push({ slug: candidate.slug, reason: ensured.kind });
    } catch (err) {
      result.failed.push({
        slug: candidate.slug,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
  }
  log('info', 'backfill', {
    dryRun,
    candidates: result.candidates,
    created: result.created.length,
    existing: result.existing.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
  });
  return result;
}
