import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  bountiesSearchIndex,
  collectionsSearchIndex,
  comicsSearchIndex,
} from '~/server/search-index';

// Five indexes ship `user.profilePicture`. This module rebuilds three; `users` is already
// enqueued at both call sites, and `images` is excluded below.
//
// Each resolves the avatar by a separate fetch in its own `pullData`, and every
// `prepareBatches` filters on `"createdAt" >= lastUpdatedAt` — so an existing document is
// rebuilt only by an explicit enqueue. Nothing enqueued on an avatar change, and
// `remove-replaced-images` destroys the old image 30 days later.
//
// The removal-side leg in collection-media-index resolves nothing on a replacement, by
// construction; it covers a live-avatar delete, which never reaches here. See the route-7
// note there.
//
// ⚠️ TWO AVATAR CHANGES STILL REACH NEITHER PATH, both latent rather than live:
//   - `Image.onDelete: SetNull` clears `profilePictureId` in the database with no code
//     involved, so a moderator or ingestion delete of a LIVE avatar reaches only that
//     collections leg — bounties and comics keep the dead url.
//   - `/intent/avatar` sets the legacy `User.image` column instead, which all three
//     indexes also denormalize and no predicate here compares. One non-deleted account
//     in prod carries it, owning no indexed collection.
//
// ⚠️ `images` is excluded deliberately: the fan-out is per image, not per project — one
// sampled uploader owns 831,541 — so queueing it behind a profile save is a six-figure
// rebuild. It needs its own mechanism. Pinned by a test.
//
// Leaf module: import no other service. `user.service` and `user.controller` both call it
// and both are widely imported, so a service import here is a cycle.
//
// Non-throwing by contract: this runs after a committed write, so a throw would fail a
// successful profile save or a completed account deletion over index bookkeeping.

/** Bounds the fan-out per entity. The largest collection owner has 8,987. */
const OWNED_ENTITY_CAP = 10_000;

/**
 * Measured on the prod replica: `Collection_userId_idx` cost 6.77 / 0.51 ms,
 * `Bounty_userId_idx` 3.57 / 0.02 ms, `ComicProject_userId_idx` 2.50 / 0.02 ms.
 *
 * 🔴 `index` is a THUNK, not the handle. `user.service` is a hub, so this module loads
 * into ~21 suites that hand-list their `~/server/search-index` mock; reading a handle
 * here would be a module-scope access and vitest throws `No "<name>" export is defined on
 * the mock` at import time. That fails the suite with ZERO tests collected — a shape that
 * reads as a pass to anything checking a count.
 */
const OWNED_ENTITIES = [
  {
    name: 'collections',
    index: () => collectionsSearchIndex,
    ownedBy: (userId: number) =>
      dbWrite.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Collection" WHERE "userId" = ${userId} LIMIT ${OWNED_ENTITY_CAP + 1}`,
  },
  {
    name: 'bounties',
    index: () => bountiesSearchIndex,
    ownedBy: (userId: number) =>
      dbWrite.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Bounty" WHERE "userId" = ${userId} LIMIT ${OWNED_ENTITY_CAP + 1}`,
  },
  {
    name: 'comics',
    index: () => comicsSearchIndex,
    ownedBy: (userId: number) =>
      dbWrite.$queryRaw<{ id: number }[]>`
        SELECT id FROM "ComicProject" WHERE "userId" = ${userId} LIMIT ${OWNED_ENTITY_CAP + 1}`,
  },
] as const;

function logFailure(name: string, source: string, message: string, error: unknown) {
  logToAxiom({
    type: 'error',
    name,
    message: `${source}: ${message}`,
    source,
    error: safeError(error),
  }).catch(() => undefined);
}

/**
 * Rebuild every search document that denormalizes this user's avatar.
 *
 * Call it wherever `User.profilePictureId` changes.
 *
 * Reads through `dbWrite`: a row missed to replica lag is a permanently stale document,
 * not a late one.
 */
export async function queueOwnerAvatarReindex({
  userId,
  source,
}: {
  userId: number;
  source: string;
}) {
  const queued: Record<string, number> = {};

  for (const entity of OWNED_ENTITIES) {
    let ids: number[];
    try {
      const rows = await entity.ownedBy(userId);
      ids = [...new Set(rows.map((r) => r.id))];
    } catch (error) {
      logFailure(
        'owner-avatar-index-resolve-failed',
        source,
        `failed to resolve ${entity.name} owned by user ${userId}`,
        error
      );
      continue;
    }

    if (ids.length > OWNED_ENTITY_CAP) {
      // Named, not silent: past the cap those documents keep the old avatar until a full
      // reindex, and nobody can notice that from an absent log line.
      // No figure: the lookup stops one past the cap, so any number here would be `1`
      // however large the real overflow.
      logToAxiom({
        type: 'warning',
        name: 'owner-avatar-index-truncated',
        message: `${source}: user ${userId} owns more than ${OWNED_ENTITY_CAP} ${entity.name}; an unknown number beyond the cap keep the previous avatar until a full reindex.`,
        source,
        cap: OWNED_ENTITY_CAP,
      }).catch(() => undefined);
      ids = ids.slice(0, OWNED_ENTITY_CAP);
    }

    if (!ids.length) continue;

    try {
      // Unchunked: `addToQueue` already splits at 10,000, which is the cap, so chunking
      // here would only turn one `sAdd` into many bucket-read round trips.
      await entity
        .index()
        .queueUpdate(ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })));
      queued[entity.name] = ids.length;
    } catch (error) {
      logFailure(
        'owner-avatar-index-enqueue-failed',
        source,
        `failed to queue ${entity.name} rebuild for user ${userId}`,
        error
      );
    }
  }

  return queued;
}
