import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

export async function registerFileLocation(params: {
  fileId: number;
  modelVersionId: number;
  modelId: number;
  backend: string;
  path: string;
  sizeKb: number;
}) {
  if (!env.STORAGE_RESOLVER_INTERNAL_URL || !env.STORAGE_RESOLVER_INTERNAL_TOKEN) {
    // Surface misconfig to Axiom — silently skipping here breaks downloads
    // just as surely as a thrown error, and callers' catch blocks never fire.
    logToAxiom({
      type: 'warning',
      name: 'register-file-location-skipped',
      reason: 'storage-resolver-not-configured',
      ...params,
    }).catch(() => undefined);
    return;
  }

  const response = await fetch(`${env.STORAGE_RESOLVER_INTERNAL_URL}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.STORAGE_RESOLVER_INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`Failed to register file location: ${response.status} ${text}`);
  }

  return response.json();
}

type DeregisterFileLocationsResult = { deleted: number };

/**
 * Deregister ALL storage-resolver `file_locations` rows for a deleted model
 * version. Best-effort by design: this runs post-commit in the version-delete
 * path and must never throw into (or block) the delete — every failure is
 * caught and logged, and the function resolves to `null`.
 *
 * Why this exists: for a tiered file, `ModelFile.url` is a known-stale pointer
 * (the tiering jobs move bytes between backends and update
 * `file_locations.path`/`backend` without rewriting `ModelFile.url`), so the
 * `ModelFile.url`-keyed S3 cleanup misses the real object AND the surviving
 * `file_locations` row keeps that object whitelisted against the dereference-
 * quarantine sweep — a permanent leak. Removing the row here turns the object
 * into a true storage orphan the existing sweep reclaims (reversibly) on its
 * next cycle. No bytes are deleted from civitai; deregistration is the whole fix.
 */
export async function deregisterFileLocations(
  modelVersionId: number
): Promise<DeregisterFileLocationsResult | null> {
  if (!env.STORAGE_RESOLVER_INTERNAL_URL || !env.STORAGE_RESOLVER_INTERNAL_TOKEN) {
    // Not configured in this pod — nothing to deregister. Surface once to Axiom
    // (a silently-skipped deregister re-grows the orphan backlog just like a
    // thrown error would), then return.
    logToAxiom({
      type: 'warning',
      name: 'deregister-file-locations-skipped',
      reason: 'storage-resolver-not-configured',
      modelVersionId,
    }).catch(() => undefined);
    return null;
  }

  try {
    const response = await fetch(`${env.STORAGE_RESOLVER_INTERNAL_URL}/deregister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.STORAGE_RESOLVER_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ modelVersionId }),
      // Unconditional timeout (NOT the flag-gated hot-path helper): deleteVersionById
      // is awaited on the tRPC request path, and a hung resolver — one that accepts
      // the socket but never replies — would otherwise block a user's delete
      // indefinitely. Version-delete is a rare owner/mod action, so a fixed 30s cap
      // is safe; best-effort semantics are unchanged (an abort is caught below).
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      logToAxiom({
        type: 'error',
        name: 'deregister-file-locations-failed',
        modelVersionId,
        status: response.status,
        message: text,
      }).catch(() => undefined);
      return null;
    }

    const result = (await response.json().catch(() => null)) as {
      deleted?: number;
    } | null;
    return { deleted: result?.deleted ?? 0 };
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'deregister-file-locations-error',
      modelVersionId,
      error,
    }).catch(() => undefined);
    return null;
  }
}

// Cap per request well under the resolver's own limit — one bulk delete (a
// nightly draft-reap batch, a perma-delete) can carry far more ids than
// a single request should. 500 keeps each POST small while collapsing thousands
// of ids into a handful of round-trips.
const DEREGISTER_BATCH_CHUNK_SIZE = 500;

/**
 * Batch variant of {@link deregisterFileLocations} for the BULK delete paths
 * (remove-old-drafts cron, permaDeleteModelById) that reap many
 * versions at once. Same purpose and best-effort contract: it runs post-commit,
 * NEVER throws into (or blocks) the delete, and returns `null` on a config skip.
 *
 * Semantics: de-dupes and drops non-positive ids, then POSTs the surviving ids
 * in chunks of {@link DEREGISTER_BATCH_CHUNK_SIZE} to the same `/deregister`
 * endpoint (which also accepts `{ modelVersionIds }`), summing `deleted` across
 * chunks. A failed chunk is logged and skipped — it does NOT abort the rest, so
 * one bad chunk can't leave the remaining versions' rows leaked.
 */
export async function deregisterFileLocationsBatch(
  modelVersionIds: number[]
): Promise<DeregisterFileLocationsResult | null> {
  if (!env.STORAGE_RESOLVER_INTERNAL_URL || !env.STORAGE_RESOLVER_INTERNAL_TOKEN) {
    // Not configured in this pod — nothing to deregister. Surface once to Axiom
    // (a silently-skipped deregister re-grows the orphan backlog just like a
    // thrown error would), then return.
    logToAxiom({
      type: 'warning',
      name: 'deregister-file-locations-skipped',
      reason: 'storage-resolver-not-configured',
      count: modelVersionIds.length,
    }).catch(() => undefined);
    return null;
  }

  // De-dupe + drop non-positive ids. If nothing survives, there's no work — skip
  // the network round-trip entirely and report a clean zero.
  const ids = Array.from(new Set(modelVersionIds)).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return { deleted: 0 };

  let deleted = 0;
  for (let i = 0; i < ids.length; i += DEREGISTER_BATCH_CHUNK_SIZE) {
    const chunkIds = ids.slice(i, i + DEREGISTER_BATCH_CHUNK_SIZE);
    try {
      const response = await fetch(`${env.STORAGE_RESOLVER_INTERNAL_URL}/deregister`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.STORAGE_RESOLVER_INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({ modelVersionIds: chunkIds }),
        // Per-chunk unconditional timeout — a hung resolver (accepts the socket,
        // never replies) must not stall a bulk delete's post-commit cleanup.
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        logToAxiom({
          type: 'error',
          name: 'deregister-file-locations-failed',
          count: chunkIds.length,
          status: response.status,
          message: text,
        }).catch(() => undefined);
        // Best-effort: skip this chunk, keep going with the rest.
        continue;
      }

      const result = (await response.json().catch(() => null)) as {
        deleted?: number;
      } | null;
      deleted += result?.deleted ?? 0;
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'deregister-file-locations-error',
        count: chunkIds.length,
        error,
      }).catch(() => undefined);
      // Best-effort: a failed chunk is logged and skipped, never aborts the loop.
    }
  }

  return { deleted };
}
