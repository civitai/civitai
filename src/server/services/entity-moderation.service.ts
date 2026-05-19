import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { XGuardLabelResult, XGuardModerationOutput } from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

type SlimMatchedTermsText = { text: string[] };
type SlimMatchedTermsPrompt = { positivePrompt: string[]; negativePrompt: string[] };

type SlimLabelResultBase = {
  label: string;
  threshold: number;
  score: number;
  error?: string;
  modelReason?: string;
  postprocess?: string;
};

export type SlimTextLabelResult = SlimLabelResultBase & {
  matchedTerms?: SlimMatchedTermsText;
};

export type SlimPromptLabelResult = SlimLabelResultBase & {
  matchedTerms?: SlimMatchedTermsPrompt;
};

export type SlimTextModerationOutput = {
  blocked: boolean;
  triggeredLabels: string[];
  results: SlimTextLabelResult[];
  signalMetadata?: XGuardModerationOutput['signalMetadata'];
};

export type SlimPromptModerationOutput = {
  blocked: boolean;
  triggeredLabels: string[];
  results: SlimPromptLabelResult[];
  signalMetadata?: XGuardModerationOutput['signalMetadata'];
};

/**
 * Trims an XGuard label result down to the fields consumers actually need.
 * Drops internal model details (action, triggered, topToken, field, finishReason,
 * responseId) and conditionally omits explanation fields when the label did not
 * trigger (score < threshold). The matchedTerms shape depends on moderation mode:
 * text mode keeps only `text`, prompt mode keeps only positive/negative prompts.
 */
function slimLabelResult(result: XGuardLabelResult, mode: 'text'): SlimTextLabelResult;
function slimLabelResult(result: XGuardLabelResult, mode: 'prompt'): SlimPromptLabelResult;
function slimLabelResult(
  result: XGuardLabelResult,
  mode: 'text' | 'prompt'
): SlimTextLabelResult | SlimPromptLabelResult {
  const { label, threshold, score, postprocess, error } = result;
  const triggered = score >= threshold;
  const slim: SlimLabelResultBase & {
    matchedTerms?: SlimMatchedTermsText | SlimMatchedTermsPrompt;
  } = { label, threshold, score };
  if (error) slim.error = error;
  if (triggered) {
    slim.modelReason = result.modelReason;
    if (postprocess) slim.postprocess = postprocess;
    if (result.matchedTerms) {
      slim.matchedTerms =
        mode === 'text'
          ? { text: result.matchedTerms.text }
          : {
              positivePrompt: result.matchedTerms.positivePrompt,
              negativePrompt: result.matchedTerms.negativePrompt,
            };
    }
  }
  return slim as SlimTextLabelResult | SlimPromptLabelResult;
}

export function slimTextModerationOutput(output: XGuardModerationOutput): SlimTextModerationOutput {
  return {
    blocked: output.blocked,
    triggeredLabels: output.triggeredLabels,
    results: output.results.map((r) => slimLabelResult(r, 'text')),
    ...(output.signalMetadata ? { signalMetadata: output.signalMetadata } : {}),
  };
}

export function slimPromptModerationOutput(
  output: XGuardModerationOutput
): SlimPromptModerationOutput {
  return {
    blocked: output.blocked,
    triggeredLabels: output.triggeredLabels,
    results: output.results.map((r) => slimLabelResult(r, 'prompt')),
    ...(output.signalMetadata ? { signalMetadata: output.signalMetadata } : {}),
  };
}

export function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export async function upsertEntityModerationPending({
  entityType,
  entityId,
  workflowId,
  contentHash,
}: {
  entityType: string;
  entityId: number;
  workflowId: string | null;
  contentHash?: string;
}) {
  return dbWrite.entityModeration.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    create: {
      entityType,
      entityId,
      workflowId,
      contentHash,
      status: EntityModerationStatus.Pending,
    },
    update: {
      workflowId,
      contentHash,
      status: EntityModerationStatus.Pending,
      blocked: null,
      triggeredLabels: [],
      result: Prisma.JsonNull,
    },
  });
}

/**
 * Records a successful moderation result. Only updates the row if the stored
 * `workflowId` still matches the callback's workflowId — this prevents a late
 * callback from a stale workflow from clobbering a newer in-flight workflow.
 * Returns `true` if the row was updated, `false` if the callback was stale.
 */
export async function recordEntityModerationSuccess(
  {
    entityType,
    entityId,
    workflowId,
    output,
  }: {
    entityType: string;
    entityId: number;
    workflowId: string;
    output: XGuardModerationOutput;
  },
  tx?: Prisma.TransactionClient
) {
  const client = tx ?? dbWrite;
  const { blocked, triggeredLabels } = output;
  const result = await client.entityModeration.updateMany({
    where: { entityType, entityId, workflowId },
    data: {
      status: EntityModerationStatus.Succeeded,
      blocked,
      triggeredLabels,
      result: slimTextModerationOutput(output) as Prisma.InputJsonValue,
    },
  });
  return result.count > 0;
}

/**
 * Records a non-success terminal state (Failed/Expired/Canceled). Only updates
 * if the stored `workflowId` matches — see `recordEntityModerationSuccess`.
 * Returns `true` if the row was updated, `false` if the callback was stale.
 */
export async function recordEntityModerationFailure(
  {
    entityType,
    entityId,
    workflowId,
    status,
  }: {
    entityType: string;
    entityId: number;
    workflowId: string;
    status: Exclude<EntityModerationStatus, 'Pending' | 'Succeeded'>;
  },
  tx?: Prisma.TransactionClient
) {
  const client = tx ?? dbWrite;
  const result = await client.entityModeration.updateMany({
    where: { entityType, entityId, workflowId },
    data: {
      status,
      retryCount: { increment: 1 },
    },
  });
  return result.count > 0;
}

/**
 * Per-entity moderation hooks. One adapter per `entityType` that flows through
 * `EntityModeration`. Lets the webhook, the retry cron, and any future
 * consumer route operations through a single registry instead of three
 * parallel maps keyed by entityType.
 *
 * Adapters live in their owning service file (e.g. Article's lives next to
 * the article service; Wildcard's lives in `wildcard-category-audit.service`)
 * and get wired into a central registry in `moderation-adapters.ts`. This
 * file deliberately does NOT import the adapter implementations — the
 * registry file does, to keep the dependency direction one-way.
 */
export type ModerationAdapter = {
  /**
   * Bulk-resolve the current text content for entities of this type. Used by
   * the retry job to batch-fetch content across many entities in one DB
   * round-trip. Entities whose underlying record is gone (or, for wildcards,
   * empty) should be absent from the returned map — the retry job treats
   * absence as "the entity went away, clean up the EM row."
   */
  resolveContent: (ids: number[]) => Promise<Map<number, string>>;

  /**
   * Submit (or resubmit) one entity for moderation. The EM upsert is owned
   * by `createXGuardModerationRequest`, so adapters typically just call the
   * appropriate wrapper helper (`submitTextModeration`,
   * `submitWildcardCategoryAudit`, etc.). Returns the workflow info or null
   * when the submit failed (in which case the helper has already written
   * the EM row as Failed for the retry job to pick up).
   */
  submit: (args: {
    entityId: number;
    content: string;
  }) => Promise<{ id?: string | null } | null | undefined>;

  /**
   * Optional: business logic to apply after a successful moderation
   * callback has been recorded onto EM (e.g. publish/unpublish, notify,
   * recompute downstream aggregates).
   */
  applyResult?: (args: {
    entityId: number;
    workflowId: string;
    blocked: boolean;
    triggeredLabels: string[];
    output: XGuardModerationOutput;
  }) => Promise<void>;

  /**
   * Optional: business logic to apply after a terminal-failure callback
   * (Failed/Expired/Canceled) has been recorded onto EM.
   */
  applyFailure?: (args: {
    entityId: number;
    workflowId: string;
    status: 'failed' | 'expired' | 'canceled';
  }) => Promise<void>;
};

/**
 * Returns the entity's text moderation row joined with the max nsfwLevel
 * derived from connected images via ImageConnection.
 */
export async function getEntityModerationWithImageNsfwLevel({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: number;
}) {
  const rows = await dbRead.$queryRaw<
    Array<{
      id: number;
      entityType: string;
      entityId: number;
      workflowId: string | null;
      status: EntityModerationStatus;
      retryCount: number;
      blocked: boolean | null;
      triggeredLabels: string[];
      result: unknown;
      contentHash: string | null;
      createdAt: Date;
      updatedAt: Date;
      imageNsfwLevel: number | null;
    }>
  >`
    SELECT
      em.*,
      COALESCE(MAX(i."nsfwLevel"), 0) AS "imageNsfwLevel"
    FROM "EntityModeration" em
    LEFT JOIN "ImageConnection" ic
      ON ic."entityType" = em."entityType" AND ic."entityId" = em."entityId"
    LEFT JOIN "Image" i ON i.id = ic."imageId"
    WHERE em."entityType" = ${entityType} AND em."entityId" = ${entityId}
    GROUP BY em.id
    LIMIT 1
  `;
  return rows[0] ?? null;
}
