/**
 * Content resolution for scanner audit items.
 *
 * Each scan in the audit log is identified by `contentHash` (sha256 of the
 * scanned input). The actual content lives in the orchestrator for ~30 days,
 * after which only items that have been moderator-reviewed retain a snapshot
 * in `ScannerContentSnapshot`.
 *
 * - `getScanContents` resolves display content for a batch of items: snapshot
 *   first, orchestrator fetch as fallback for xguard, imageId-lookup for media.
 *   Orchestrator round-trips run in parallel so a 10-item prefetch is bounded
 *   by the slowest single workflow fetch, not the sum.
 * - `snapshotScanContent` persists content into Postgres so it survives the
 *   orchestrator's TTL. First writer per contentHash wins.
 */
import type { XGuardModerationStep } from '@civitai/client';
import type { Prisma } from '@prisma/client';
import { getWorkflow } from '@civitai/client';
import pLimit from 'p-limit';
import { dbRead, dbWrite } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom } from '~/server/logging/client';
import { scanContentBodySchema, type ScanContentBody } from '~/server/schema/scanner-review.schema';

export type ScanContentItem = {
  contentHash: string;
  /** First workflowId associated with this scan group. Used as the orchestrator
   * fetch key when no snapshot exists. */
  workflowId: string;
  scanner: string;
  /** Entity ids for the group; entityIds[0] is the imageId for image_ingestion. */
  entityIds: string[];
};

export type ScanContent = {
  contentHash: string;
  scanner: string;
  text?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  imageId?: number;
  imageUrl?: string;
  /** Per-label model reasoning, keyed by label. Resolved from the workflow
   * (xguard scans) or from the snapshot once the orchestrator's TTL has lapsed. */
  labelReasons?: Record<string, string>;
  /** True when neither snapshot nor orchestrator could resolve the content. */
  unavailable: boolean;
  /** Short tag identifying which code path returned `unavailable: true`. Set
   * server-side and shown in the UI alert so moderators (and we) can tell
   * "the orchestrator 404'd" from "the snapshot had no text" at a glance. */
  unavailableReason?: string;
};

// Bound the parallel orchestrator round-trips so a 50-item page doesn't fire
// 50 simultaneous getWorkflow calls and trip rate-limiting/timeouts on the
// orchestrator side. Snapshot lookups happen before we even enter the limit.
const ORCHESTRATOR_FETCH_CONCURRENCY = 8;

async function resolveScanContent(
  item: ScanContentItem,
  snapshotMap: Map<string, { contentHash: string; scanner: string; content: unknown }>
): Promise<ScanContent> {
  const snap = snapshotMap.get(item.contentHash);
  if (snap) {
    // `content` is a JSON blob; validate at the boundary. If a malformed
    // row sneaks in (manual SQL edit etc.), treat as unavailable so we
    // surface the problem rather than serving broken data.
    const parsed = scanContentBodySchema.safeParse(snap.content);
    if (!parsed.success) {
      await logToAxiom({
        name: 'scanner-content-unavailable',
        type: 'warning',
        reason: 'snapshot-parse-failed',
        message: parsed.error.message,
        contentHash: item.contentHash,
        workflowId: item.workflowId,
      });
      return {
        contentHash: item.contentHash,
        scanner: snap.scanner,
        unavailable: true,
        unavailableReason: 'snapshot-parse-failed',
      };
    }
    return {
      contentHash: item.contentHash,
      scanner: snap.scanner,
      text: parsed.data.text,
      positivePrompt: parsed.data.positivePrompt,
      negativePrompt: parsed.data.negativePrompt,
      imageId: parsed.data.imageId,
      labelReasons: parsed.data.labelReasons,
      unavailable: false,
    };
  }

  // Image mode: the imageId is already on the audit row, no orchestrator
  // call needed. URL gets resolved in the second pass below.
  if (item.scanner === 'image_ingestion') {
    const raw = item.entityIds[0];
    const imageId = raw ? Number(raw) : NaN;
    if (Number.isNaN(imageId)) {
      await logToAxiom({
        name: 'scanner-content-unavailable',
        type: 'warning',
        reason: 'image-id-missing',
        contentHash: item.contentHash,
        entityIds: item.entityIds,
      });
    }
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      imageId: Number.isNaN(imageId) ? undefined : imageId,
      unavailable: Number.isNaN(imageId),
      unavailableReason: Number.isNaN(imageId) ? 'image-id-missing' : undefined,
    };
  }

  // xguard text / prompt: fetch workflow from orchestrator.
  if (!item.workflowId) {
    await logToAxiom({
      name: 'scanner-content-unavailable',
      type: 'warning',
      reason: 'workflow-id-empty',
      contentHash: item.contentHash,
      scanner: item.scanner,
    });
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      unavailable: true,
      unavailableReason: 'workflow-id-empty',
    };
  }
  try {
    // The @civitai/client doesn't throw on non-2xx — it returns
    // { data: undefined, error, response }. We have to explicitly check
    // for error responses, otherwise a rate-limited or 5xx response
    // silently falls through as `data === undefined`.
    const { data, error, response } = await getWorkflow({
      client: internalOrchestratorClient,
      path: { workflowId: item.workflowId },
    });
    if (error || !data) {
      await logToAxiom({
        name: 'scanner-content-unavailable',
        type: 'warning',
        reason: 'orchestrator-non-success',
        contentHash: item.contentHash,
        workflowId: item.workflowId,
        status: response?.status,
        error: error ? String(JSON.stringify(error)).slice(0, 500) : 'no data',
      });
      return {
        contentHash: item.contentHash,
        scanner: item.scanner,
        unavailable: true,
        unavailableReason: `orchestrator-non-success (status ${response?.status ?? 'unknown'})`,
      };
    }
    // Find the xGuardModeration step rather than assuming steps[0] —
    // resilient to future workflow shapes that add other steps around it.
    const step = (data.steps ?? []).find(
      (s) => (s as { $type?: string }).$type === 'xGuardModeration'
    ) as XGuardModerationStep | undefined;
    if (!step?.input) {
      const stepTypes = (data.steps ?? []).map(
        (s) => (s as { $type?: string }).$type ?? '(no $type)'
      );
      await logToAxiom({
        name: 'scanner-content-unavailable',
        type: 'warning',
        reason: 'workflow-step-input-missing',
        contentHash: item.contentHash,
        workflowId: item.workflowId,
        stepTypes,
        stepCount: data.steps?.length ?? 0,
      });
      return {
        contentHash: item.contentHash,
        scanner: item.scanner,
        unavailable: true,
        unavailableReason: `workflow-step-input-missing (step types: ${
          stepTypes.length > 0 ? stepTypes.join(', ') : 'none'
        })`,
      };
    }
    const input = step.input as {
      mode?: string;
      text?: string;
      positivePrompt?: string;
      negativePrompt?: string | null;
    };
    // Per-label modelReason — used by the focused review UI in place of
    // the column that used to live in ClickHouse.
    const labelReasons: Record<string, string> = {};
    for (const r of step.output?.results ?? []) {
      if (r.modelReason) labelReasons[r.label] = r.modelReason;
    }
    if (item.scanner === 'xguard_text') {
      const inputKeys = Object.keys(input ?? {});
      if (!input.text) {
        await logToAxiom({
          name: 'scanner-content-unavailable',
          type: 'warning',
          reason: 'workflow-input-text-empty',
          contentHash: item.contentHash,
          workflowId: item.workflowId,
          inputKeys,
        });
      }
      return {
        contentHash: item.contentHash,
        scanner: item.scanner,
        text: input.text ?? undefined,
        labelReasons,
        unavailable: !input.text,
        unavailableReason: !input.text
          ? `workflow-input-text-empty (input keys: ${inputKeys.join(', ') || 'none'})`
          : undefined,
      };
    }
    const inputKeys = Object.keys(input ?? {});
    if (!input.positivePrompt) {
      await logToAxiom({
        name: 'scanner-content-unavailable',
        type: 'warning',
        reason: 'workflow-input-positivePrompt-empty',
        contentHash: item.contentHash,
        workflowId: item.workflowId,
        inputKeys,
      });
    }
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      positivePrompt: input.positivePrompt ?? undefined,
      negativePrompt: input.negativePrompt ?? undefined,
      labelReasons,
      unavailable: !input.positivePrompt,
      unavailableReason: !input.positivePrompt
        ? `workflow-input-positivePrompt-empty (input keys: ${inputKeys.join(', ') || 'none'})`
        : undefined,
    };
  } catch (e) {
    await logToAxiom({
      name: 'scanner-content-unavailable',
      type: 'warning',
      reason: 'orchestrator-fetch-threw',
      message: (e as Error).message,
      contentHash: item.contentHash,
      workflowId: item.workflowId,
    });
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      unavailable: true,
      unavailableReason: `orchestrator-fetch-threw: ${(e as Error).message}`,
    };
  }
}

export async function getScanContents(items: ScanContentItem[]): Promise<ScanContent[]> {
  if (items.length === 0) return [];

  const contentHashes = items.map((i) => i.contentHash);
  const snapshots = await dbRead.scannerContentSnapshot.findMany({
    where: { contentHash: { in: contentHashes } },
  });
  const snapshotMap = new Map(snapshots.map((s) => [s.contentHash, s]));

  const limit = pLimit(ORCHESTRATOR_FETCH_CONCURRENCY);
  const results = await Promise.all(
    items.map((item) => limit(() => resolveScanContent(item, snapshotMap)))
  );

  // Resolve image URLs in one Postgres round trip rather than per-item.
  const imageIds = Array.from(
    new Set(results.map((r) => r.imageId).filter((id): id is number => typeof id === 'number'))
  );
  if (imageIds.length) {
    const images = await dbRead.image.findMany({
      where: { id: { in: imageIds } },
      select: { id: true, url: true },
    });
    const imageMap = new Map(images.map((img) => [img.id, img.url]));
    for (const r of results) {
      if (r.imageId !== undefined) {
        const url = imageMap.get(r.imageId);
        if (url) r.imageUrl = url;
        else {
          await logToAxiom({
            name: 'scanner-content-unavailable',
            type: 'warning',
            reason: 'image-url-not-found',
            contentHash: r.contentHash,
            imageId: r.imageId,
          });
          r.unavailable = true;
          r.unavailableReason = `image-url-not-found (imageId ${r.imageId})`;
        }
      }
    }
  }

  return results;
}

/**
 * Fetch a workflow's full JSON payload from the orchestrator for moderator
 * inspection. Returns `null` if the workflow no longer exists (past the 30-day
 * TTL). The shape mirrors @civitai/client's Workflow type.
 */
export async function getWorkflowRaw(workflowId: string): Promise<unknown> {
  try {
    const { data, error, response } = await getWorkflow({
      client: internalOrchestratorClient,
      path: { workflowId },
    });
    if (error || !data) {
      await logToAxiom({
        name: 'scanner-workflow-fetch-failed',
        type: 'warning',
        workflowId,
        status: response?.status,
        error: error ? String(JSON.stringify(error)).slice(0, 500) : 'no data',
      });
      return null;
    }
    return data;
  } catch (e) {
    await logToAxiom({
      name: 'scanner-workflow-fetch-failed',
      type: 'warning',
      message: (e as Error).message,
      workflowId,
    });
    return null;
  }
}

export async function snapshotScanContent(input: {
  contentHash: string;
  scanner: string;
  body: ScanContentBody;
}) {
  // Strip undefined fields out before storing so the JSON is tight (no
  // explicit `null`s for unused per-mode fields).
  const compact: ScanContentBody = {};
  if (input.body.text !== undefined) compact.text = input.body.text;
  if (input.body.positivePrompt !== undefined) compact.positivePrompt = input.body.positivePrompt;
  if (input.body.negativePrompt !== undefined) compact.negativePrompt = input.body.negativePrompt;
  if (input.body.instructions !== undefined) compact.instructions = input.body.instructions;
  if (input.body.imageId !== undefined) compact.imageId = input.body.imageId;
  if (input.body.labelReasons && Object.keys(input.body.labelReasons).length > 0) {
    compact.labelReasons = input.body.labelReasons;
  }

  // Upsert with empty `update` so the first verdict per contentHash writes
  // the snapshot and subsequent verdicts are idempotent no-ops. Avoids
  // check-then-insert race windows.
  await dbWrite.scannerContentSnapshot.upsert({
    where: { contentHash: input.contentHash },
    create: {
      contentHash: input.contentHash,
      scanner: input.scanner,
      content: compact as Prisma.InputJsonValue,
    },
    update: {},
  });
}
