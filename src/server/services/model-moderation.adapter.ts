import type { XGuardModerationOutput } from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import {
  collectMatchedTerms,
  missingRequestedLabels,
  triggeredLabelDetails,
  triggeredLabelKeys,
} from '~/server/services/moderation-label-helpers';
import { recordModelTextModerationOutcome } from '~/server/prom/model-moderation.metrics';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import {
  applyModelNsfwTextScan,
  applySystemModelNsfwFlag,
} from '~/server/services/text-scan/actions/model-nsfw';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { removeTags } from '~/utils/string-helpers';

export const MODEL_MODERATION_ENTITY_TYPE = 'Model' as const;

/**
 * Every label submitted on a model scan. Twelve of them are recorded and not acted on —
 * their trigger rates on real model text are the input to deciding what a v2 acts on, and
 * there is no way to collect them without scanning.
 *
 * Owned here rather than imported from another consumer: per-consumer label selection is
 * the pattern (Article sends one, Challenge two, wildcard a fail set plus a level set), and
 * importing App Blocks' list would couple two sets that are allowed to diverge.
 */
export const MODEL_MODERATION_SCAN_LABELS = [
  'NSFW',
  'Suggestive',
  'Explicit',
  'Young',
  'Grooming',
  'Sex Trafficking',
  'Exploitation',
  'Extremism',
  'Impersonating Civitai Staff',
  'Bestiality',
  'Urine',
  'Diaper',
  'Scat',
  'Menstruation',
  'Celebrity',
] as const;

/** Triggering any of these sets `nsfw = true`. Lowercase — comparisons normalize both sides. */
const MODEL_MODERATION_LEVEL_LABELS = ['nsfw', 'suggestive', 'explicit'] as const;

const LEVEL_LABEL_SET: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);

/**
 * Cap on the matched terms persisted per model. XGuard sets the cardinality from a body
 * that can be 167 KB, and `Model.meta` is selected for every row of the model feed — a
 * column whose p99 is 310 bytes today. The terms are a moderator's starting point, not an
 * exhaustive record; the full set stays on the scan's own row.
 */
const MAX_PERSISTED_MATCHED_TERMS = 50;

/**
 * The single definition of the scanned string.
 *
 * The submit path, `resolveContent`, and the backfill all call this. A second copy that
 * drifts breaks `contentHash` dedup silently — the retry cron re-audits already-scanned
 * models forever and nothing reports an error.
 */
export function buildModelModerationText(model: {
  name: string;
  description?: string | null;
}): string {
  return [model.name, model.description ? removeTags(model.description) : null]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Labels this scan counts as triggered.
 *
 * Three views of the same fact reach us — the callback's own `triggeredLabels`, the copy on
 * the scan output, and per-label `triggered`/`score` — and they are allowed to disagree
 * because they cross a network boundary. Union all of them so a label present in only one
 * still counts.
 */
function modelTriggeredLabelKeys({
  output,
  triggeredLabels,
}: {
  output?: {
    results?: XGuardModerationOutput['results'];
    triggeredLabels?: string[] | null;
  } | null;
  triggeredLabels?: string[] | null;
}) {
  return triggeredLabelKeys(
    {
      results: output?.results,
      triggeredLabels: [...(triggeredLabels ?? []), ...(output?.triggeredLabels ?? [])],
    },
    { includeScoreThreshold: true }
  );
}

export function isModelTextNsfw({
  triggeredLabels,
  results,
}: {
  triggeredLabels?: string[];
  results?: XGuardModerationOutput['results'];
}): boolean {
  for (const label of modelTriggeredLabelKeys({ output: { results }, triggeredLabels }))
    if (LEVEL_LABEL_SET.has(label)) return true;
  return false;
}

/** Is model text moderation submitting at all for this model? */
async function submitEnabled(entityId: number) {
  return isFlipt(FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD, String(entityId));
}

/**
 * The one place a model scan is requested. Three callers reach it — the model write path,
 * the retry cron via the adapter hook, and the backfill — and a divergence between them
 * changes what lands in the audit corpus without failing anything.
 */
function submitModelScan({
  entityId,
  content,
  forceRescan,
}: {
  entityId: number;
  content: string;
  forceRescan?: boolean;
}) {
  return submitTextModeration({
    entityType: MODEL_MODERATION_ENTITY_TYPE,
    entityId,
    content,
    labels: [...MODEL_MODERATION_SCAN_LABELS],
    priority: 'low',
    recordForReview: true,
    ...(forceRescan ? { forceRescan: true } : {}),
  });
}

/** Merges the scan's forensics into `Model.meta` without reading it first. */
async function recordForensics({
  entityId,
  matchedTerms,
  labels,
}: {
  entityId: number;
  matchedTerms: string[];
  labels: { label: string; score: number; threshold: number }[];
}) {
  // Bound as TEXT and cast in SQL rather than bound as jsonb — binding a jsonb
  // parameter breaks when two copies of @prisma/client are in the bundle.
  const labelsJson = JSON.stringify(labels);

  // Database-side jsonb merge, not a read-modify-write of the whole object. A
  // `minorFlagSnapshot` written between the read and the write would otherwise be
  // erased, and that key is what gates the owner's appeal flow.
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      'textModeration', jsonb_build_object(
        'labels', ${labelsJson}::jsonb,
        'matchedTerms', to_jsonb(${matchedTerms}::text[]),
        'scannedAt', now()
      )
    )
    WHERE m.id = ${entityId}
  `;
}

export const modelModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.model.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, description: true },
    });
    return new Map(rows.map((r) => [r.id, buildModelModerationText(r)]));
  },

  // Lets the retry cron skip Model rows wholesale while the feature is dark, BEFORE it
  // spends their retry budget. Without it the cron pre-increments `retryCount` on stuck
  // Pending rows, gets a declined submit back, and burns all nine attempts inside a couple
  // of hours — after which the rows are never retried again, including once the flag
  // returns.
  isEnabled: async ({ entityId }) =>
    (await getTextScanMode(MODEL_MODERATION_ENTITY_TYPE, entityId)) === 'active' ||
    submitEnabled(entityId),

  submit: ({ entityId, content }) =>
    submitTextModerationOrScan({
      entityType: MODEL_MODERATION_ENTITY_TYPE,
      entityId,
      // Gated as well as `isEnabled`: a caller that reaches the hook directly must not be
      // able to request an XGuard scan the flag has turned off. Undefined is contractual
      // here — the same shape as a submit the helper itself declined.
      xguard: async () => {
        if (!(await submitEnabled(entityId))) return undefined;
        return submitModelScan({ entityId, content });
      },
    }),

  applyTextScan: async (args) => {
    await applyModelNsfwTextScan(args);
  },

  // `output.blocked` is deliberately unread. The submit sends fifteen labels this adapter
  // does not act on beyond the three level labels, several with Block or Review actions
  // orchestrator-side, so honouring `blocked` would let an unacted label change the
  // outcome. Recompute locally from the level labels instead.
  applyResult: async ({ entityId, triggeredLabels: callbackLabels, output }) => {
    const missingLabels = missingRequestedLabels(output, MODEL_MODERATION_SCAN_LABELS);
    if (missingLabels.length) {
      logToAxiom({
        name: 'model-text-moderation',
        type: 'warning',
        message: 'requested label missing from scan results',
        modelId: entityId,
        missingLabels,
      }).catch(() => null);
    }

    // The union, not the raw `triggeredLabels` field — the verdict below is computed from
    // it, so recording anything narrower would leave a model flagged with no forensics
    // naming the label that flagged it.
    const triggered = modelTriggeredLabelKeys({ output, triggeredLabels: callbackLabels });
    const triggeredLabels = [...triggered];
    if (!triggeredLabels.some((label) => LEVEL_LABEL_SET.has(label))) return;

    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD_APPLY, String(entityId))))
      return;

    const db = await getDbWithoutLag('model', entityId);
    const model = await db.model.findUnique({
      where: { id: entityId },
      select: { id: true, nsfw: true, nsfwLevel: true, lockedProperties: true, userId: true },
    });
    // Deleted between submit and callback — a bare update would throw P2025 and fail the
    // moderation callback, which the orchestrator would then retry forever.
    if (!model) return;

    const matchedTerms = collectMatchedTerms(output, triggered).slice(
      0,
      MAX_PERSISTED_MATCHED_TERMS
    );
    const labels = triggeredLabelDetails(output, triggered);

    // Recorded whether or not the flip happens, matching the profanity branch: a moderator
    // reviewing a model they already ruled on still needs to see that the scan disagreed.
    await recordForensics({ entityId, matchedTerms, labels });

    const result = await applySystemModelNsfwFlag({ model, source: 'xguard-text-moderation' });
    recordModelTextModerationOutcome(result);
    if (result === 'declined_race') {
      logToAxiom({
        name: 'model-text-moderation',
        type: 'warning',
        message: 'nsfw lock appeared between read and write; flag not applied',
        modelId: entityId,
      }).catch(() => null);
      return;
    }
    if (result !== 'applied') return;

    logToAxiom({
      name: 'model-text-moderation',
      type: 'info',
      message: 'nsfw flag applied',
      modelId: entityId,
      triggeredLabels,
      // Scores, not just names: during a ramp the question is whether flags are
      // landing near their thresholds (policy needs tuning) or far above them.
      labels,
    }).catch(() => null);
  },

  // No applyFailure. A model's visibility does not gate on its text scan, so a terminal
  // failure leaves it as-is and the EntityModeration row is enough for the retry cron.
  // The omission is deliberate — do not add an empty hook.
};

/**
 * Fire-and-forget submit for the model write path. Owns its own flag check and error
 * handling so `upsertModel` gets a single awaitable that can never fail the save.
 */
export async function submitModelTextModeration(model: {
  id: number;
  name: string;
  description?: string | null;
  isModerator?: boolean;
}): Promise<void> {
  // Same carve-out as the profanity branch's `!isModerator` guard in `upsertModel`: an
  // unattended scan must never re-flip a decision a moderator just made while editing the
  // same text (enforceLockedProperties returns early for moderators, so the lock they cleared
  // stays cleared going into this call).
  if (model.isModerator) return;

  const content = buildModelModerationText(model);
  try {
    await submitTextModerationOrScan({
      entityType: MODEL_MODERATION_ENTITY_TYPE,
      entityId: model.id,
      xguard: async () => {
        if (!content || !(await submitEnabled(model.id))) return null;
        return submitModelScan({ entityId: model.id, content });
      },
    });
  } catch (e) {
    logToAxiom({
      name: 'model-text-moderation',
      type: 'error',
      message: (e as Error).message,
      modelId: model.id,
    }).catch(() => null);
  }
}

/**
 * Where the backfill's next call should resume.
 *
 * Lives here rather than in the endpoint because nothing under `src/pages` can carry a test —
 * Next treats every file there as a route and `next build` fails the route-type validation.
 *
 * Three cases, and getting any of them wrong loses rows silently rather than erroring:
 * a window that filled its `limit` was not fully drained, so it must resume from the last
 * candidate; a drained window advances by the whole window, because a call that matched
 * nothing still made progress; and only a window reaching past the last id terminates.
 */
export function resolveBackfillCursor({
  windowEnd,
  maxId,
  lastCandidateId,
  truncated,
}: {
  windowEnd: number;
  maxId: number;
  lastCandidateId?: number;
  truncated: boolean;
}): number | null {
  if (truncated && lastCandidateId !== undefined) return lastCandidateId;
  return windowEnd >= maxId ? null : windowEnd;
}

/**
 * Backfill submit. Deliberately not flag-gated — the two situations the backfill exists for
 * are re-running after the apply flag goes up and re-running after a rollback, and both are
 * moments when the flags are down. `forceRescan` bypasses the contentHash dedup so a model
 * already scanned during the shadow phase gets a fresh verdict rather than the cached one,
 * which would never re-enter `applyResult`. Routed: once Model is `active` a forced text scan
 * replaces the XGuard rescan, which would otherwise write an XGuard Pending over the text-scan row.
 */
export async function submitModelTextModerationBackfill(model: {
  id: number;
  name: string;
  description?: string | null;
}) {
  const content = buildModelModerationText(model);
  if (!content) return null;
  return submitTextModerationOrScan({
    entityType: MODEL_MODERATION_ENTITY_TYPE,
    entityId: model.id,
    force: true,
    xguard: () => submitModelScan({ entityId: model.id, content, forceRescan: true }),
  });
}
