import { z } from 'zod';
import { sql } from '@civitai/db/kysely';
import { getWorkflow, type XGuardModerationStep } from '@civitai/client';
import { dbRead, dbWrite } from './db';
import { getOrchestratorClient } from './orchestrator';
import type { ScanContent } from '$lib/scanner-audit';

export type { ScanContent };

// Content resolution for scanner-audit items. Ported from the main app's scanner-content.service. Each
// scan is keyed by contentHash; the content lives in the orchestrator for ~30 days, after which a
// moderator-reviewed item keeps a Postgres snapshot. Resolution: snapshot first, orchestrator fallback
// (xguard), imageId lookup (media). Axiom diagnostics are dropped for console.warn in the spoke.

export type ScanContentItem = {
  contentHash: string;
  workflowId: string;
  scanner: string;
  entityIds: string[];
};

export type ScanContentBody = {
  text?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  instructions?: string;
  imageId?: number;
  labelReasons?: Record<string, string>;
  userId?: number;
};

const scanContentBodySchema = z.object({
  text: z.string().optional(),
  positivePrompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  instructions: z.string().optional(),
  imageId: z.number().int().optional(),
  labelReasons: z.record(z.string(), z.string()).optional(),
  userId: z.number().int().optional(),
});

async function resolveScanContent(
  item: ScanContentItem,
  snapshotMap: Map<string, { scanner: string; content: unknown }>
): Promise<ScanContent> {
  const snap = snapshotMap.get(item.contentHash);
  if (snap) {
    const parsed = scanContentBodySchema.safeParse(snap.content);
    if (!parsed.success) {
      return {
        contentHash: item.contentHash,
        scanner: snap.scanner,
        unavailable: true,
        unavailableReason: 'snapshot-parse-failed',
      };
    }
    return { contentHash: item.contentHash, scanner: snap.scanner, ...parsed.data, unavailable: false };
  }

  if (item.scanner === 'image_ingestion') {
    const raw = item.entityIds[0];
    const imageId = raw ? Number(raw) : NaN;
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      imageId: Number.isNaN(imageId) ? undefined : imageId,
      unavailable: Number.isNaN(imageId),
      unavailableReason: Number.isNaN(imageId) ? 'image-id-missing' : undefined,
    };
  }

  if (!item.workflowId) {
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      unavailable: true,
      unavailableReason: 'workflow-id-empty',
    };
  }

  try {
    const { data, error, response } = await getWorkflow({
      client: getOrchestratorClient(),
      path: { workflowId: item.workflowId },
    });
    if (error || !data) {
      return {
        contentHash: item.contentHash,
        scanner: item.scanner,
        unavailable: true,
        unavailableReason: `orchestrator-non-success (status ${response?.status ?? 'unknown'})`,
      };
    }
    const step = (data.steps ?? []).find(
      (s) => (s as { $type?: string }).$type === 'xGuardModeration'
    ) as XGuardModerationStep | undefined;
    if (!step?.input) {
      return {
        contentHash: item.contentHash,
        scanner: item.scanner,
        unavailable: true,
        unavailableReason: 'workflow-step-input-missing',
      };
    }
    const input = step.input as {
      text?: string;
      positivePrompt?: string;
      negativePrompt?: string | null;
    };
    const labelReasons: Record<string, string> = {};
    for (const r of step.output?.results ?? []) {
      if (r.modelReason) labelReasons[r.label.toLowerCase()] = r.modelReason;
    }
    const userId =
      typeof data.metadata?.userId === 'number' ? (data.metadata.userId as number) : undefined;

    if (item.scanner === 'xguard_text') {
      return {
        contentHash: item.contentHash,
        scanner: item.scanner,
        text: input.text ?? undefined,
        labelReasons,
        userId,
        unavailable: !input.text,
        unavailableReason: !input.text ? 'workflow-input-text-empty' : undefined,
      };
    }
    return {
      contentHash: item.contentHash,
      scanner: item.scanner,
      positivePrompt: input.positivePrompt ?? undefined,
      negativePrompt: input.negativePrompt ?? undefined,
      labelReasons,
      userId,
      unavailable: !input.positivePrompt,
      unavailableReason: !input.positivePrompt ? 'workflow-input-positivePrompt-empty' : undefined,
    };
  } catch (e) {
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
  const snapshots = await dbRead
    .selectFrom('ScannerContentSnapshot')
    .select(['contentHash', 'scanner', 'content'])
    .where('contentHash', 'in', contentHashes)
    .execute();
  const snapshotMap = new Map(snapshots.map((s) => [s.contentHash, s]));

  const results = await Promise.all(items.map((item) => resolveScanContent(item, snapshotMap)));

  // Resolve image URLs in one round trip.
  const imageIds = [
    ...new Set(results.map((r) => r.imageId).filter((id): id is number => typeof id === 'number')),
  ];
  if (imageIds.length) {
    const images = await dbRead
      .selectFrom('Image')
      .select(['id', 'url'])
      .where('id', 'in', imageIds)
      .execute();
    const imageMap = new Map(images.map((img) => [img.id, img.url]));
    for (const r of results) {
      if (r.imageId !== undefined) {
        const url = imageMap.get(r.imageId);
        if (url) r.imageUrl = url;
        else {
          r.unavailable = true;
          r.unavailableReason = `image-url-not-found (imageId ${r.imageId})`;
        }
      }
    }
  }

  return results;
}

export async function getWorkflowRaw(workflowId: string): Promise<unknown> {
  try {
    const { data, error } = await getWorkflow({
      client: getOrchestratorClient(),
      path: { workflowId },
    });
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.warn('[scanner-content] getWorkflowRaw failed', workflowId, (e as Error).message);
    return null;
  }
}

export async function snapshotScanContent(input: {
  contentHash: string;
  scanner: string;
  body: ScanContentBody;
}): Promise<void> {
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.body)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    compact[k] = v;
  }

  // First verdict per contentHash writes the snapshot; subsequent are no-ops.
  await dbWrite
    .insertInto('ScannerContentSnapshot')
    .values({
      contentHash: input.contentHash,
      scanner: input.scanner,
      content: sql`${JSON.stringify(compact)}::jsonb`,
    })
    .onConflict((oc) => oc.column('contentHash').doNothing())
    .execute();
}
