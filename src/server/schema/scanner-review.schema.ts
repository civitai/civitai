import * as z from 'zod';
import { ReviewVerdict } from '~/shared/utils/prisma/enums';

export const scannerSchema = z.enum(['xguard_text', 'xguard_prompt', 'image_ingestion']);
export type Scanner = z.infer<typeof scannerSchema>;

export const queueViewSchema = z.enum(['triggered', 'near-miss']);
export type QueueView = z.infer<typeof queueViewSchema>;

export const listScansSchema = z.object({
  scanner: scannerSchema.optional(),
  view: queueViewSchema.default('triggered'),
  label: z.string().optional(),
  version: z.string().optional(),
  /** For near-miss view: maximum gap between threshold and score for an
   * untriggered row to be considered a near-miss. A row matches when
   * `threshold - score <= nearMissGap`. Default 0.05 — only items that came
   * within 0.05 of triggering count as near-misses; everything further away
   * is noise we don't want in the mod queue. */
  nearMissGap: z.number().min(0).max(1).default(0.05),
  /** Partition-prune window. Defaults to 30 days on the server. */
  lookbackDays: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  /** Filter to only the latest `policyHash` per (scanner, label). Defaults true
   * — mods reviewing the queue should only see results from current policies.
   * Pass false to see historical policy versions (e.g. for FP-rate comparison
   * pre/post a policy change). Ignored when an explicit `version` is passed. */
  latestVersionOnly: z.boolean().default(true),
});

export const getScanDetailSchema = z.object({
  contentHash: z.string().min(1),
  version: z.string(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
});

/**
 * Shape of the JSON `content` column on `ScannerContentSnapshot`. Fields are
 * all optional because they vary by scanner mode — caller writes the subset
 * relevant to the scan, reader checks the row's `scanner` column to know
 * which fields to expect. New scanner modes add fields here without a
 * schema migration.
 */
export const scanContentBodySchema = z.object({
  text: z.string().optional(),
  positivePrompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  instructions: z.string().optional(),
  imageId: z.number().int().optional(),
  /** Per-label model reasoning, keyed by label. Lives on the workflow and is
   * resolved lazily for the focused-review UI; snapshotted here so it survives
   * the orchestrator's 30-day TTL once a mod has touched the item. */
  labelReasons: z.record(z.string(), z.string()).optional(),
  /** Submitting user id when known. Same pattern as labelReasons — pulled
   * from workflow metadata and snapshotted on verdict so it survives the
   * orchestrator's TTL. Surfaced in the focused-review UI for moderator
   * follow-up. */
  userId: z.number().int().optional(),
});
export type ScanContentBody = z.infer<typeof scanContentBodySchema>;

export const upsertLabelVerdictSchema = z.object({
  contentHash: z.string().min(1),
  version: z.string(),
  label: z.string().min(1),
  verdict: z.nativeEnum(ReviewVerdict),
  note: z.string().max(2000).optional(),
  /** Optional content snapshot. Sent by the focused-review page; server upserts
   * ScannerContentSnapshot if no row exists for this contentHash yet so the
   * content survives the orchestrator's 30-day TTL. First verdict per item
   * snapshots; subsequent mod verdicts are no-ops on the snapshot. */
  contentSnapshot: z
    .object({
      scanner: z.string(),
      body: scanContentBodySchema,
    })
    .optional(),
});

export const focusedRunSchema = z.object({
  scanner: scannerSchema,
  label: z.string().min(1),
  lookbackDays: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  /** Same semantics as on `listScansSchema` — untriggered rows are excluded
   * unless `threshold - score <= nearMissGap`. Triggered rows are always
   * included. */
  nearMissGap: z.number().min(0).max(1).default(0.05),
  /** Filter to only the latest `policyHash` (version) for this label.
   * Defaults true — focused review shows current-policy results only. */
  latestVersionOnly: z.boolean().default(true),
});

/** Single-item content resolver for the focused page. Called per-item as the
 * mod cursors through the run, with React Query prefetching the next N items
 * in the background. Splitting this out of `focusedRun` lets the run queue
 * paint in ~200ms instead of waiting for ~50 orchestrator round-trips. */
export const focusedItemContentSchema = z.object({
  contentHash: z.string().min(1),
  workflowId: z.string(),
  scanner: z.string().min(1),
  entityIds: z.array(z.string()),
});

export const getWorkflowRawSchema = z.object({
  workflowId: z.string().min(1),
});

export const deleteLabelVerdictSchema = z.object({
  contentHash: z.string().min(1),
  version: z.string(),
  label: z.string().min(1),
});

export const exportRowsSchema = listScansSchema.extend({
  limit: z.number().int().min(1).max(50000).default(10000),
});
