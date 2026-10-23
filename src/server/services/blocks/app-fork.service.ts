/**
 * App Blocks — FORKABLE APPS: the author's opt-in and fork provenance.
 *
 * An author can mark their on-site app forkable ("Let others fork this app's source"). A fork
 * keeps a link to its parent for ATTRIBUTION ONLY: "Forked from …" on the fork's store page and
 * a fork count on the parent's. No revenue share, and nothing is inherited — a fork's scopes,
 * paid goods and approvals all come from its OWN publish review.
 *
 * The data lives in six manual-apply columns (migration `20261126120000_app_fork_provenance`):
 *   - `app_listings.forkable`               — the author's opt-in (on the LIVE listing only);
 *   - `app_listings.fork_of_listing_id`     — the parent's store listing, set on the fork's
 *                                             approve (FK, ON DELETE SET NULL);
 *   - `app_blocks.fork_of_app_block_id` / `fork_of_commit_sha`
 *                                           — the parent block and the parent commit the fork
 *                                             started at;
 *   - `app_block_publish_requests.fork_of_app_block_id` / `fork_of_commit_sha`
 *                                           — the same pair, carried onto each request and read
 *                                             on approve.
 *
 * 🔴 RAW SQL, AND ONLY HERE. Every one of those columns is marked no-type in
 * `schema.full.prisma`, so it is stripped from the generated client and does not exist on any
 * Prisma delegate. That is deliberate and is the `AppListing.visibility` lesson: as ordinary
 * fields, every `appListing` / `appBlock` / `appBlockPublishRequest` call returning rows without
 * an explicit `select` would name them, and would 500 with P2022 until a human applies the
 * migration. Stripped, nothing outside this module can name them, so the deploy and the
 * migration can land in either order.
 *
 * 🔴 PROVENANCE IS SERVER-WRITTEN, NEVER READ FROM THE MANIFEST. The manifest is author-
 * controlled: if a parent could be declared there, any author could attach their app to a
 * popular one (or detach a fork from its parent). Every writer below takes its values as
 * explicit arguments from server code, and the approve path reads the REQUEST'S columns —
 * `app_block_publish_requests.manifest` is never consulted. The forgery test in
 * `app-fork.service.behavior.test.ts` pins that.
 *
 * 🔴 TWO READ POSTURES, like `app-listing-beta.service.ts`. A read that licenses a WRITE
 * (`readListingForkable`) degrades ONLY on a missing column and reports `available: false`; a
 * read for a RENDER (`readListingForkProvenanceForRender`) degrades on ANY error, because a
 * provenance line must never take a store page down.
 *
 * 🔴 NOT A CATALOG AXIS. Neither `forkable` nor `fork_of_listing_id` is read by the cached
 * `/apps` id page (`listAvailableListings`), so no write here busts the catalog cache.
 */

import { TRPCError } from '@trpc/server';

import { logToAxiom } from '~/server/logging/client';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import type { ListingForkOf } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The client surface this module needs: raw SQL and nothing else, structurally typed so a
 * replica client, a primary client, an interactive-transaction client and a test double over an
 * in-process Postgres all satisfy it. Every call is the TAGGED-TEMPLATE form (`db.$queryRaw`…``), the
 * shape the rest of this codebase uses and its tests decode.
 */
export type ForkRawClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: any, ...values: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRaw: (query: any, ...values: any[]) => Promise<any>;
};

/** A read-only client — the render and opt-in reads never write. */
export type ForkReadClient = Pick<ForkRawClient, '$queryRaw'>;

// ---------------------------------------------------------------------------
// The author's opt-in
// ---------------------------------------------------------------------------

/** What a guarded read of `app_listings.forkable` yields. */
export type ListingForkableRead = {
  /**
   * True when the column was readable. `false` ⇒ the migration has not been applied here, the
   * value below is a placeholder, and no write may name the column.
   */
  available: boolean;
  /** The stored opt-in, or `false` for "not forkable" AND for "could not read". */
  forkable: boolean;
};

export const FORKABLE_UNAVAILABLE: ListingForkableRead = Object.freeze({
  available: false,
  forkable: false,
});

/**
 * Read one listing's opt-in BY ID, degrading to {@link FORKABLE_UNAVAILABLE} when the column is
 * missing. Everything else PROPAGATES: this read licenses a write, and reporting a database
 * outage as "not available on this environment" would be a lie to the author.
 *
 * A listing id that matches no row reads `{ available: true, forkable: false }` — the column was
 * readable, there was simply no row.
 */
export async function readListingForkable(
  listingId: string,
  db: ForkReadClient
): Promise<ListingForkableRead> {
  try {
    const rows =
      (await db.$queryRaw`SELECT "forkable" FROM "app_listings" WHERE "id" = ${listingId} LIMIT 1`) as Array<{
        forkable: boolean | null;
      }>;
    return { available: true, forkable: rows[0]?.forkable === true };
  } catch (err) {
    if (isMissingColumnError(err)) return FORKABLE_UNAVAILABLE;
    throw err;
  }
}

/**
 * The message an author sees when they change the opt-in before the migration has run.
 * Exported so the tests assert the exact string.
 */
export const FORKABLE_UNAVAILABLE_MESSAGE =
  "Forking is not available on this environment yet. Leave “Let others fork this app's source” unchanged and try again later.";

/**
 * Gate an author's write of the opt-in on the migration. REFUSES rather than omitting: the author
 * ticked the box and expects to see it ticked again, so a silent drop would report success for a
 * setting that never saved. `PRECONDITION_FAILED` — the value is fine, the environment is not
 * ready. Callers run this BEFORE any side effect.
 */
export function assertForkableWritable(available: boolean): void {
  if (available === true) return;
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FORKABLE_UNAVAILABLE_MESSAGE });
}

/** Refusal for an off-site listing: it has no source on the platform to fork. */
export const FORKABLE_OFFSITE_MESSAGE =
  'Only apps hosted on Civitai can be forked — an external app has no source here to fork.';

/** Refusal for the revision-draft write path: the opt-in is never staged on a shadow. */
export const FORKABLE_ON_REVISION_MESSAGE =
  'Forking is set on the live app, not on a revision draft. Change it from the app’s Details tab.';

/**
 * Write the opt-in onto ONE live listing.
 *
 * 🔴 `revision_of_id IS NULL` IS LOAD-BEARING: the opt-in is TRIVIAL (no moderator review) and is
 * never staged on a shadow revision, exactly like beta. A shadow's own column would be read by
 * nothing, and an author whose toggle landed there would see it do nothing.
 *
 * Returns the number of rows written (0 when the id is a shadow or does not exist).
 */
export async function writeListingForkable(
  db: Pick<ForkRawClient, '$executeRaw'>,
  listingId: string,
  forkable: boolean
): Promise<number> {
  return Number(
    await db.$executeRaw`UPDATE "app_listings"
        SET "forkable" = ${forkable}, "updated_at" = now()
        WHERE "id" = ${listingId} AND "revision_of_id" IS NULL`
  );
}

// ---------------------------------------------------------------------------
// Provenance, as the store detail page reads it
// ---------------------------------------------------------------------------

/** One listing's fork facts, as the render path needs them. */
export type ListingForkProvenance = {
  /** The author's opt-in. */
  forkable: boolean;
  /** The parent's store listing, or `null` (not a fork, or the parent listing is gone). */
  forkOfListingId: string | null;
  /**
   * Whether this listing's app IS a fork — true even after the parent was deleted, because the
   * backing block's `fork_of_commit_sha` has no foreign key and outlives it. This is what lets the
   * page say "Forked from an app that is no longer available" rather than nothing at all.
   */
  isFork: boolean;
};

export const NO_FORK_PROVENANCE: ListingForkProvenance = Object.freeze({
  forkable: false,
  forkOfListingId: null,
  isFork: false,
});

/**
 * Read one listing's fork facts. Degrades to {@link NO_FORK_PROVENANCE} on a missing column only;
 * everything else propagates. Use {@link readListingForkProvenanceForRender} on a page.
 */
export async function readListingForkProvenance(
  listingId: string,
  db: ForkReadClient
): Promise<ListingForkProvenance> {
  try {
    const rows = (await db.$queryRaw`SELECT
          al."forkable" AS "forkable",
          al."fork_of_listing_id" AS "forkOfListingId",
          (al."fork_of_listing_id" IS NOT NULL
            OR ab."fork_of_app_block_id" IS NOT NULL
            OR ab."fork_of_commit_sha" IS NOT NULL) AS "isFork"
        FROM "app_listings" al
        LEFT JOIN "app_blocks" ab ON ab."id" = al."app_block_id"
        WHERE al."id" = ${listingId}
        LIMIT 1`) as Array<{
      forkable: boolean | null;
      forkOfListingId: string | null;
      isFork: boolean | null;
    }>;
    const row = rows[0];
    if (!row) return NO_FORK_PROVENANCE;
    return {
      forkable: row.forkable === true,
      forkOfListingId: row.forkOfListingId ?? null,
      isFork: row.isFork === true,
    };
  } catch (err) {
    if (isMissingColumnError(err)) return NO_FORK_PROVENANCE;
    throw err;
  }
}

/**
 * Record a degraded render read without letting the recording break the page. A missing column
 * never reaches here (the narrow reader swallows it), so what arrives is a real fault — `error`.
 * The `.catch(() => null)` is load-bearing: nothing awaits this, so an unhandled rejection would
 * take down the render this exists only to observe.
 */
function noteDegradedForkRead(name: string, err: unknown): void {
  try {
    logToAxiom({
      name,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      code: (err as { code?: unknown })?.code ?? null,
    }).catch(() => null);
  } catch {
    // The degraded path's whole job is to keep rendering; a logger that throws synchronously
    // must not undo that.
  }
}

/**
 * {@link readListingForkProvenance} for a RENDERING path — degrades on ANY error. A provenance
 * line is cosmetic; a statement timeout on it must not 500 a public store page.
 */
export async function readListingForkProvenanceForRender(
  listingId: string,
  db: ForkReadClient
): Promise<ListingForkProvenance> {
  try {
    return await readListingForkProvenance(listingId, db);
  } catch (err) {
    noteDegradedForkRead('app-fork-provenance-read-degraded', err);
    return NO_FORK_PROVENANCE;
  }
}

/**
 * Turn a listing's provenance into the "Forked from …" attribution the store page shows.
 *
 * `lookupVisibleParent` must answer with the parent's `{ slug, name }` ONLY when THIS viewer may
 * see the parent's store page, and `null` otherwise — the caller passes the same gate the public
 * detail read applies (`loadStoreVisibleListingRow`).
 *
 * 🔴 NO LEAK OF A HIDDEN PARENT. A parent the viewer may not see (unapproved, removed, private,
 * mature on a SFW host, on-site under an external-only scope) and a parent that no longer exists
 * read IDENTICALLY — `{ visible: false }` — so the attribution cannot be used to learn a hidden
 * listing's name, or even whether it still exists. A lookup that throws reads the same way.
 *
 * Returns `null` for a listing that is not a fork.
 */
export async function resolveForkAttribution(
  provenance: ListingForkProvenance,
  lookupVisibleParent: (listingId: string) => Promise<{ slug: string; name: string } | null>
): Promise<ListingForkOf | null> {
  if (!provenance.isFork) return null;
  if (!provenance.forkOfListingId) return { visible: false };
  try {
    const parent = await lookupVisibleParent(provenance.forkOfListingId);
    return parent ? { visible: true, slug: parent.slug, name: parent.name } : { visible: false };
  } catch (err) {
    noteDegradedForkRead('app-fork-attribution-degraded', err);
    return { visible: false };
  }
}

// ---------------------------------------------------------------------------
// Provenance writers — SERVER-SIDE ONLY
// ---------------------------------------------------------------------------

/**
 * A parent commit sha as Forgejo reports it: lowercase hex, SHA-1 (40) or SHA-256 (64). Required
 * on every provenance write, because `fork_of_commit_sha` is the marker that survives the
 * parent's deletion (see {@link ListingForkProvenance.isFork}).
 */
export const FORK_COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Thrown when a provenance writer is handed values it must not store. */
export class ForkProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForkProvenanceError';
  }
}

function assertProvenanceArgs(args: {
  selfId: string;
  forkOfAppBlockId: string;
  forkOfCommitSha: string;
}): void {
  if (!args.forkOfAppBlockId) throw new ForkProvenanceError('forkOfAppBlockId is required');
  if (!FORK_COMMIT_SHA_RE.test(args.forkOfCommitSha)) {
    throw new ForkProvenanceError('forkOfCommitSha must be a lowercase 40- or 64-hex commit sha');
  }
  if (args.selfId === args.forkOfAppBlockId) {
    throw new ForkProvenanceError('an app cannot be a fork of itself');
  }
}

/**
 * Record that `appBlockId` was forked from `forkOfAppBlockId` at `forkOfCommitSha`.
 *
 * For the FORK FLOW (the code that bootstraps a fork from a parent's source), when the fork's
 * block already exists. WRITE-ONCE: a block that already carries provenance is left untouched and
 * the call returns `false`, so provenance can be neither rewritten nor cleared after the fact.
 * Also returns `false` when the parent block does not exist.
 *
 * 🔴 Pass values the server resolved itself — never anything read from a manifest or a request
 * body.
 */
export async function setAppBlockForkProvenance(
  db: Pick<ForkRawClient, '$executeRaw'>,
  args: { appBlockId: string; forkOfAppBlockId: string; forkOfCommitSha: string }
): Promise<boolean> {
  assertProvenanceArgs({ selfId: args.appBlockId, ...args });
  const count = Number(
    await db.$executeRaw`UPDATE "app_blocks"
        SET "fork_of_app_block_id" = ${args.forkOfAppBlockId},
            "fork_of_commit_sha" = ${args.forkOfCommitSha}
        WHERE "id" = ${args.appBlockId}
          AND "fork_of_app_block_id" IS NULL
          AND "fork_of_commit_sha" IS NULL
          AND EXISTS (SELECT 1 FROM "app_blocks" p WHERE p."id" = ${args.forkOfAppBlockId})`
  );
  return count > 0;
}

/**
 * Record fork provenance on a PENDING publish request.
 *
 * For a fork's FIRST version, which has no block yet (a block is created on its first approve),
 * so {@link carryForkProvenanceToPublishRequest} has nothing to carry from. On approve,
 * {@link applyForkProvenanceOnApprove} stamps the new block from the request, after which every
 * later version carries it automatically.
 *
 * Write-once and pending-only; returns `false` when nothing was written. Refuses a request whose
 * own block IS the claimed parent.
 */
export async function setPublishRequestForkProvenance(
  db: Pick<ForkRawClient, '$executeRaw'>,
  args: { publishRequestId: string; forkOfAppBlockId: string; forkOfCommitSha: string }
): Promise<boolean> {
  assertProvenanceArgs({ selfId: '', ...args });
  const count = Number(
    await db.$executeRaw`UPDATE "app_block_publish_requests"
        SET "fork_of_app_block_id" = ${args.forkOfAppBlockId},
            "fork_of_commit_sha" = ${args.forkOfCommitSha}
        WHERE "id" = ${args.publishRequestId}
          AND "status" = 'pending'
          AND "fork_of_app_block_id" IS NULL
          AND "fork_of_commit_sha" IS NULL
          AND ("app_block_id" IS NULL OR "app_block_id" <> ${args.forkOfAppBlockId})
          AND EXISTS (SELECT 1 FROM "app_blocks" p WHERE p."id" = ${args.forkOfAppBlockId})`
  );
  return count > 0;
}

/**
 * Copy the app's own provenance onto a publish request that was just created for it.
 *
 * Called by every path that creates a publish request for an existing app (`submitVersion`,
 * `recordPendingFromPush`). The source is the block row the slug names — a server-written column —
 * so the request inherits exactly what the block already says, and never anything from the
 * manifest it carries.
 *
 * BEST-EFFORT, NEVER THROWS: a missing column (migration not applied) is silent, any other error
 * is logged, and both return `false`. Provenance is attribution; it must not fail an author's
 * submit.
 */
export async function carryForkProvenanceToPublishRequest(
  db: Pick<ForkRawClient, '$executeRaw'>,
  args: { publishRequestId: string; slug: string }
): Promise<boolean> {
  try {
    const count = Number(
      await db.$executeRaw`UPDATE "app_block_publish_requests" pr
          SET "fork_of_app_block_id" = ab."fork_of_app_block_id",
              "fork_of_commit_sha" = ab."fork_of_commit_sha"
          FROM "app_blocks" ab
          WHERE pr."id" = ${args.publishRequestId}
            AND ab."block_id" = ${args.slug}
            AND (ab."fork_of_app_block_id" IS NOT NULL OR ab."fork_of_commit_sha" IS NOT NULL)
            AND pr."fork_of_app_block_id" IS NULL
            AND pr."fork_of_commit_sha" IS NULL`
    );
    return count > 0;
  } catch (err) {
    if (!isMissingColumnError(err)) noteDegradedForkRead('app-fork-provenance-carry-failed', err);
    return false;
  }
}

/** What {@link applyForkProvenanceOnApprove} did. */
export type ForkApproveOutcome =
  /** The request carries no provenance — an ordinary app. */
  | 'not-a-fork'
  /** The fork's listing now points at its parent's listing. */
  | 'linked'
  /**
   * Provenance recorded on the block, but no listing link was written: the fork's listing already
   * had one, the parent has no live store listing, the parent block is gone, or the fork's
   * listing does not exist yet (its creation is log-and-continue on approve; the next approve
   * converges).
   */
  | 'no-listing-link'
  /** The migration is not applied in this environment. */
  | 'unavailable';

/**
 * On approve of `publishRequestId` (whose app is `appBlockId`): carry the request's provenance onto
 * the block and link the fork's store listing to the parent's.
 *
 *   1. Read `fork_of_app_block_id` / `fork_of_commit_sha` from the REQUEST row. Nothing else —
 *      🔴 never the request's manifest (see the module header).
 *   2. Stamp the block if it has no provenance yet. A fork's first approve CREATES its block, so
 *      this is how the block learns it is a fork; on a later approve the block already has it and
 *      the write-once guard makes this a no-op.
 *   3. Point the fork's live listing (`app_block_id = appBlockId`, not a shadow, not yet linked) at
 *      the parent block's live listing.
 *
 * Idempotent: every write is guarded on "not yet set", so a re-approve converges without
 * rewriting anything. Never links a listing to itself.
 *
 * The caller wraps this in log-and-continue: attribution must never block an approve or a deploy.
 */
export async function applyForkProvenanceOnApprove(
  db: ForkRawClient,
  args: { publishRequestId: string; appBlockId: string }
): Promise<ForkApproveOutcome> {
  let request: { forkOfAppBlockId: string | null; forkOfCommitSha: string | null } | undefined;
  try {
    const rows = (await db.$queryRaw`SELECT COALESCE("fork_of_app_block_id", "manifest"->>'forkOfAppBlockId') AS "forkOfAppBlockId",
          COALESCE("fork_of_commit_sha", "manifest"->>'forkOfCommitSha') AS "forkOfCommitSha"
        FROM "app_block_publish_requests"
        WHERE "id" = ${args.publishRequestId}
        LIMIT 1`) as Array<{ forkOfAppBlockId: string | null; forkOfCommitSha: string | null }>;
    request = rows[0];
  } catch (err) {
    if (isMissingColumnError(err)) return 'unavailable';
    throw err;
  }
  const parentBlockId = request?.forkOfAppBlockId ?? null;
  const commitSha = request?.forkOfCommitSha ?? null;
  if (parentBlockId === null && commitSha === null) return 'not-a-fork';
  // A request naming its own block as the parent is not a fork of anything.
  if (parentBlockId === args.appBlockId) return 'not-a-fork';

  await db.$executeRaw`UPDATE "app_blocks"
      SET "fork_of_app_block_id" = ${parentBlockId},
          "fork_of_commit_sha" = ${commitSha}
      WHERE "id" = ${args.appBlockId}
        AND "fork_of_app_block_id" IS NULL
        AND "fork_of_commit_sha" IS NULL`;

  if (parentBlockId === null) return 'no-listing-link';
  const linked = Number(
    await db.$executeRaw`UPDATE "app_listings" fork
        SET "fork_of_listing_id" = parent."id"
        FROM "app_listings" parent
        WHERE fork."app_block_id" = ${args.appBlockId}
          AND fork."revision_of_id" IS NULL
          AND fork."fork_of_listing_id" IS NULL
          AND parent."app_block_id" = ${parentBlockId}
          AND parent."revision_of_id" IS NULL
          AND parent."id" <> fork."id"`
  );
  return linked > 0 ? 'linked' : 'no-listing-link';
}
