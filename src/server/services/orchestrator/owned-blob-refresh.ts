import type { Workflow } from '@civitai/orchestration-client';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { workflowOwnerId } from '~/server/services/orchestrator/assert-workflow-owner';
import {
  MAX_BLOB_REFRESH_BATCH,
  refreshBlobsService,
  type BlobRefreshResult,
} from '~/server/services/orchestrator/refreshBlobs';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';

/** How far back the caller's workflows are scanned; outputs of older ones are denied. */
export const OWNED_BLOB_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const OWNED_BLOB_PAGE_SIZE = 100;
/** Only the newest 500 workflows in the window are scanned; outputs of older ones are denied. */
export const MAX_OWNED_BLOB_PAGES = 5;
const SCAN_TTL_MS = CacheTTL.xs * 5 * 1000;

export type CallerBlobRefreshResult =
  | BlobRefreshResult
  /** Not shown to belong to the caller. Says nothing about the blob, so the client keeps it. */
  | { blobId: string; status: 'denied' };

type OwnedScan = {
  startedAt: number;
  fromDate: string;
  blobIds: string[];
  cursor?: string;
  pages: number;
  done: boolean;
};

/**
 * The typed output fields that hold blobs a step generated. An allowlist, not a walk: some step
 * types (merge, repeat, echo, pass-through conversions) can carry submitter-supplied values in
 * their output, and those prove nothing.
 */
const GENERATED_BLOB_FIELDS: Record<string, readonly string[]> = {
  textToImage: ['images'],
  imageGen: ['images'],
  comfy: ['blobs'],
  customComfy: ['blobs'],
  videoGen: ['video', 'additionalVideos'],
  imageUpscaler: ['blob'],
  videoUpscaler: ['video'],
  videoEnhancement: ['video'],
  videoInterpolation: ['video'],
  imageBackgroundRemoval: ['image'],
  videoBackgroundRemoval: ['video'],
  videoFrameExtraction: ['frames'],
};
/** Bounds one user's cached entry; ids past it are denied. */
const MAX_OWNED_BLOB_IDS = 5000;

type StepOutputView = { $type?: string; output?: Record<string, unknown> | null };

function addGeneratedBlobIds(step: StepOutputView, into: Set<string>) {
  const fields = step.$type ? GENERATED_BLOB_FIELDS[step.$type] : undefined;
  if (!fields || !step.output) return;
  for (const field of fields) {
    const value = step.output[field];
    for (const blob of Array.isArray(value) ? value : [value]) {
      if (into.size >= MAX_OWNED_BLOB_IDS) return;
      const id = (blob as { id?: unknown } | null)?.id;
      if (typeof id === 'string') into.add(id);
    }
  }
}

function addOwnedOutputs(workflow: Workflow, userId: number, fromMs: number, into: Set<string>) {
  if (workflowOwnerId(workflow.id) !== userId) return;
  const createdMs = Date.parse(workflow.createdAt);
  if (!(createdMs >= fromMs)) return;
  for (const step of workflow.steps ?? []) addGeneratedBlobIds(step as StepOutputView, into);
}

/**
 * Pages the caller's own workflows, newest first, until every wanted id is found, the window is
 * exhausted or the page cap is hit. The partial scan is cached so the next call resumes it.
 */
async function findOwnedOutputBlobIds({
  userId,
  token,
  wanted,
}: {
  userId: number;
  token: string;
  wanted: string[];
}): Promise<Set<string>> {
  const key = `${REDIS_KEYS.CACHES.OWNED_OUTPUT_BLOBS}:${userId}` as const;
  const cached = await redis.packed.get<OwnedScan>(key).catch(() => null);
  const now = Date.now();
  const scan: OwnedScan =
    cached && now - cached.startedAt < SCAN_TTL_MS
      ? cached
      : {
          startedAt: now,
          fromDate: new Date(now - OWNED_BLOB_WINDOW_MS).toISOString(),
          blobIds: [],
          pages: 0,
          done: false,
        };
  const owned = new Set(scan.blobIds);
  const fromMs = Date.parse(scan.fromDate);
  const missing = () => wanted.some((id) => !owned.has(id));

  let scanned = false;
  try {
    while (missing() && !scan.done && scan.pages < MAX_OWNED_BLOB_PAGES) {
      const { items, nextCursor } = await queryWorkflows({
        token,
        take: OWNED_BLOB_PAGE_SIZE,
        cursor: scan.cursor,
        tags: [],
        fromDate: new Date(fromMs),
        hideMatureContent: false,
      });
      for (const workflow of items) addOwnedOutputs(workflow, userId, fromMs, owned);
      scan.pages++;
      scan.cursor = nextCursor || undefined;
      scan.done = !nextCursor || items.length === 0;
      scanned = true;
    }
  } catch (error) {
    logToAxiom({
      type: 'warning',
      name: 'owned-blob-scan-failed',
      userId,
      pages: scan.pages,
      error: safeError(error),
    }).catch(() => undefined);
  }

  if (scanned) {
    scan.blobIds = [...owned];
    const ttlSeconds = Math.max(1, Math.ceil((scan.startedAt + SCAN_TTL_MS - Date.now()) / 1000));
    await redis.packed.set(key, scan, { EX: ttlSeconds }).catch(() => undefined);
  }
  return owned;
}

/** Re-signs only blobs output by the caller's own recent workflows; moderators may re-sign any. */
export async function refreshCallerBlobs({
  user,
  token,
  blobIds,
}: {
  user: { id: number; isModerator?: boolean };
  token: string;
  blobIds: string[];
}): Promise<CallerBlobRefreshResult[]> {
  const unique = [...new Set(blobIds)].slice(0, MAX_BLOB_REFRESH_BATCH);
  if (user.isModerator) return refreshBlobsService({ token, blobIds: unique });

  const owned = await findOwnedOutputBlobIds({ userId: user.id, token, wanted: unique });
  const allowed = unique.filter((id) => owned.has(id));
  const refreshed = allowed.length ? await refreshBlobsService({ token, blobIds: allowed }) : [];
  const byId = new Map(refreshed.map((result) => [result.blobId, result]));
  return unique.map((blobId) => byId.get(blobId) ?? { blobId, status: 'denied' });
}
