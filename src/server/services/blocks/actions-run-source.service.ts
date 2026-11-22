/**
 * Storage and reads for the GitHub Actions run an App submit came from: the eight manual-apply,
 * no-type `app_block_publish_requests.actions_run_*` columns. Verification lives in
 * `github-actions-oidc.service.ts`; this module only stores and reads what it verified, and has no
 * flag, Redis or jose import so the store page's read path stays light.
 *
 * 🔴 RAW SQL ONLY, AND ONLY HERE. The columns are `@no-type` in `schema.full.prisma`, so the Prisma
 * client does not know them and no default-select `appBlockPublishRequest` query names them. That is
 * what lets this deploy before the migration is applied: the write reports "not recorded" and every
 * read degrades to "none" on a missing column.
 *
 * 🔴 WHAT THE FIELDS MEAN: the submitting RUN's repository, tag and commit, checked against a token
 * GitHub signed. Not a claim that the bundle was built from that commit (the developer's workflow
 * uploads it), and a different trust level from the client-claimed `source_commit`. See the header of
 * `github-actions-oidc.service.ts`.
 */

import { Prisma } from '@prisma/client';

import type { ActionsRunSource } from '~/server/schema/blocks/actions-run-source.schema';
import type { ListingActionsRunSource } from '~/server/schema/blocks/app-listing-read.schema';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import { noteDegradedRead } from '~/server/services/blocks/degraded-read-log';
import { GithubActionsOidcRefusal } from '~/server/services/blocks/github-actions-oidc-refusal';

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_REF_PREFIX = 'refs/tags/';

// ---------------------------------------------------------------------------
// Storage (raw SQL; the columns are no-type and manual-apply)
// ---------------------------------------------------------------------------

/** Raw surfaces: a replica, the primary, a transaction client or a test double. */
export type ActionsRunReadClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: any, ...values: any[]) => Promise<any>;
};
export type ActionsRunWriteClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRaw: (query: any, ...values: any[]) => Promise<any>;
};

export const ACTIONS_RUN_SOURCE_DEGRADED_EVENT = 'app-block-actions-run-source-degraded';

/**
 * Store a verified run on its publish request. Best-effort: returns `false`, never throws, when
 * the columns are missing (migration not applied) or the write fails, because the request row
 * already exists and the submit must not fail after it. The run is then simply not recorded.
 */
export async function writeActionsRunSource(
  db: ActionsRunWriteClient,
  publishRequestId: string,
  source: ActionsRunSource
): Promise<boolean> {
  try {
    const n = await db.$executeRaw`UPDATE "app_block_publish_requests" SET
        "actions_run_repository" = ${source.repository},
        "actions_run_repository_id" = ${source.repositoryId},
        "actions_run_repository_owner_id" = ${source.repositoryOwnerId},
        "actions_run_sha" = ${source.sha},
        "actions_run_ref" = ${source.ref},
        "actions_run_workflow_ref" = ${source.workflowRef},
        "actions_run_repository_visibility" = ${source.repositoryVisibility},
        "actions_run_id" = ${source.runId}
      WHERE "id" = ${publishRequestId}`;
    return typeof n === 'number' ? n > 0 : true;
  } catch (err) {
    noteDegradedRead(ACTIONS_RUN_SOURCE_DEGRADED_EVENT, err);
    return false;
  }
}

type ActionsRunRow = {
  id?: unknown;
  repository: unknown;
  repositoryId: unknown;
  repositoryOwnerId: unknown;
  sha: unknown;
  ref: unknown;
  workflowRef: unknown;
  repositoryVisibility: unknown;
  runId: unknown;
};

/** A stored row as a source, or null when it carries none (or anything malformed). */
function rowToSource(row: ActionsRunRow | undefined): ActionsRunSource | null {
  if (!row) return null;
  const fields = [
    row.repository,
    row.repositoryId,
    row.repositoryOwnerId,
    row.sha,
    row.ref,
    row.workflowRef,
    row.repositoryVisibility,
    row.runId,
  ];
  if (!fields.every((f) => typeof f === 'string' && f.length > 0)) return null;
  return {
    repository: row.repository as string,
    repositoryId: row.repositoryId as string,
    repositoryOwnerId: row.repositoryOwnerId as string,
    sha: row.sha as string,
    ref: row.ref as string,
    workflowRef: row.workflowRef as string,
    repositoryVisibility: row.repositoryVisibility as string,
    runId: row.runId as string,
  };
}

const SELECT_COLUMNS = Prisma.sql`"actions_run_repository" AS "repository",
  "actions_run_repository_id" AS "repositoryId",
  "actions_run_repository_owner_id" AS "repositoryOwnerId",
  "actions_run_sha" AS "sha",
  "actions_run_ref" AS "ref",
  "actions_run_workflow_ref" AS "workflowRef",
  "actions_run_repository_visibility" AS "repositoryVisibility",
  "actions_run_id" AS "runId"`;

/**
 * Run facts for many publish requests (the moderator review): id → source, only for requests that
 * have one. ANY error yields an empty map (logged unless it is the expected missing column): a
 * provenance line must never take the review page down.
 */
export async function readActionsRunSourcesForRender(
  db: ActionsRunReadClient,
  publishRequestIds: readonly string[]
): Promise<Map<string, ActionsRunSource>> {
  const out = new Map<string, ActionsRunSource>();
  if (publishRequestIds.length === 0) return out;
  try {
    const rows = (await db.$queryRaw`SELECT "id", ${SELECT_COLUMNS}
        FROM "app_block_publish_requests"
        WHERE "id" IN (${Prisma.join([...publishRequestIds])})
          AND "actions_run_repository" IS NOT NULL`) as ActionsRunRow[] | null | undefined;
    for (const row of Array.isArray(rows) ? rows : []) {
      const source = rowToSource(row);
      if (source && typeof row.id === 'string') out.set(row.id, source);
    }
    return out;
  } catch (err) {
    if (!isMissingColumnError(err)) noteDegradedRead(ACTIONS_RUN_SOURCE_DEGRADED_EVENT, err);
    return new Map();
  }
}

/**
 * The public store row's facts: owner/repo, tag and commit, ONLY for a public repository.
 * A private or internal repository's name is never shown, so it returns null there; a ref that is
 * not a tag (which verification refuses, so only a hand-edited row) also returns null.
 */
export function publicActionsRunSource(
  source: ActionsRunSource | null
): ListingActionsRunSource | null {
  if (!source || source.repositoryVisibility !== 'public') return null;
  if (!source.ref.startsWith(TAG_REF_PREFIX)) return null;
  if (!REPOSITORY_RE.test(source.repository) || !SHA_RE.test(source.sha)) return null;
  return {
    repository: source.repository,
    tag: source.ref.slice(TAG_REF_PREFIX.length),
    sha: source.sha,
  };
}

/**
 * The run facts of the version an on-site app is SERVING, for its public store page: the approved
 * publish request whose platform commit is the block's current one (the link
 * `resolveLiveSourceCommit` uses), filtered to public repositories by {@link publicActionsRunSource}.
 * Null when the serving version has none, when the repository is not public, and on ANY error.
 * {@link readLiveActionsRunSourcesForBlocks} for that one block, so the store page and the registry
 * adapter's listing stream read it by one query.
 */
export async function readLiveActionsRunSourceForListing(
  db: ActionsRunReadClient,
  appBlockId: string
): Promise<ListingActionsRunSource | null> {
  return (await readLiveActionsRunSourcesForBlocks(db, [appBlockId])).get(appBlockId) ?? null;
}

/**
 * The serving version's run facts for many blocks in one query: block id → the facts
 * {@link readLiveActionsRunSourceForListing} describes. A block with none is absent; ANY error
 * yields an empty map (logged unless it is the expected missing column).
 */
export async function readLiveActionsRunSourcesForBlocks(
  db: ActionsRunReadClient,
  appBlockIds: readonly string[]
): Promise<Map<string, ListingActionsRunSource>> {
  const out = new Map<string, ListingActionsRunSource>();
  if (appBlockIds.length === 0) return out;
  try {
    const rows = (await db.$queryRaw`SELECT DISTINCT ON (ab."id") ab."id" AS "id", ${SELECT_COLUMNS}
        FROM "app_block_publish_requests" pr
        JOIN "app_blocks" ab ON ab."id" = pr."app_block_id"
        WHERE ab."id" IN (${Prisma.join([...appBlockIds])})
          AND ab."current_version_sha" IS NOT NULL
          AND pr."status" = 'approved'
          AND pr."forgejo_commit_sha" = ab."current_version_sha"
        ORDER BY ab."id", pr."reviewed_at" DESC NULLS LAST`) as ActionsRunRow[] | null | undefined;
    for (const row of Array.isArray(rows) ? rows : []) {
      const source = publicActionsRunSource(rowToSource(row));
      if (source && typeof row.id === 'string') out.set(row.id, source);
    }
    return out;
  } catch (err) {
    if (!isMissingColumnError(err)) noteDegradedRead(ACTIONS_RUN_SOURCE_DEGRADED_EVENT, err);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// The repository pin (phase 1; repository linking replaces it)
// ---------------------------------------------------------------------------

/** The repository an app's verified submits are pinned to. */
export type ActionsRunRepositoryPin = { repositoryId: string; repository: string };

/**
 * Refuse a verified run from a repository other than the one this app is PINNED to.
 *
 * 🔴 WHY. Without it, any repository the developer can tag could be named on any of their apps'
 * store pages. The pin is GitHub's numeric `repository_id` (it survives a rename or transfer, a
 * name does not) of the app's EARLIEST verified request that is pending or approved: the first
 * verified submit sets it, and every later one must match. Rejected and withdrawn requests do not
 * pin, so a mistaken first submit can be withdrawn and redone. Slug-keyed, because `slug` is the
 * app's identity across a first request's lifecycle (`app_block_id` is NULL until approve), and
 * the submit's ownership gate has already established the submitter may ship this slug.
 *
 * Throws `GithubActionsOidcRefusal`: 409 `repository-mismatch` naming the expected repository; 503
 * when the pin cannot be read for any reason other than a missing column. A MISSING COLUMN (the
 * manual-apply migration not applied) means no pin can exist, and nothing will be recorded either,
 * so the submit proceeds exactly as it does today.
 *
 * Phase 2 (linking an app to a repository) replaces this pin with the explicit link.
 */
export async function assertActionsRunRepositoryPinned(
  db: ActionsRunReadClient,
  slug: string,
  source: ActionsRunSource
): Promise<void> {
  let pin: ActionsRunRepositoryPin | null = null;
  try {
    const rows = (await db.$queryRaw`SELECT
          "actions_run_repository_id" AS "repositoryId",
          "actions_run_repository" AS "repository"
        FROM "app_block_publish_requests"
        WHERE "slug" = ${slug}
          AND "actions_run_repository_id" IS NOT NULL
          AND "status" IN ('pending', 'approved')
        ORDER BY "submitted_at" ASC
        LIMIT 1`) as Array<{ repositoryId: unknown; repository: unknown }> | null | undefined;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (row && typeof row.repositoryId === 'string' && row.repositoryId.length > 0) {
      pin = {
        repositoryId: row.repositoryId,
        repository: typeof row.repository === 'string' ? row.repository : row.repositoryId,
      };
    }
  } catch (err) {
    if (isMissingColumnError(err)) return;
    noteDegradedRead(ACTIONS_RUN_SOURCE_DEGRADED_EVENT, err);
    throw new GithubActionsOidcRefusal(
      'unavailable',
      "could not read this app's pinned repository; re-run the workflow",
      503
    );
  }
  if (pin && pin.repositoryId !== source.repositoryId) {
    throw new GithubActionsOidcRefusal(
      'repository-mismatch',
      `this app's verified submits come from ${pin.repository} (repository id ${pin.repositoryId}), ` +
        `but this token is from ${source.repository} (repository id ${source.repositoryId}). ` +
        `Submit from ${pin.repository}.`,
      409
    );
  }
}
