import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

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
      signal: fetchTimeoutSignal(60_000),
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
