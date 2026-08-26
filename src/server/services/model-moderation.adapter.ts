import type { XGuardModerationOutput } from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { Tracker } from '~/server/clickhouse/tracker';
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
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { removeTags } from '~/utils/string-helpers';

export const MODEL_MODERATION_ENTITY_TYPE = 'Model';

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
export const MODEL_MODERATION_LEVEL_LABELS = ['nsfw', 'suggestive', 'explicit'] as const;

const LEVEL_LABEL_SET: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);

/**
 * Cap on how many items of any one kind land in `Model.meta`. XGuard sets the cardinality from a body
 * that can be 167 KB, and `Model.meta` is selected for every row of the model feed — a
 * column whose p99 is 310 bytes today. The terms are a moderator's starting point, not an
 * exhaustive record; the full set stays on the scan's own row.
 */
const MAX_PERSISTED_META_ITEMS = 50;

/**
 * The same budget spent on version findings, where the unit is an object rather than a term
 * string and version names carry no length bound anywhere in the schema. Fifty untrimmed
 * entries reach ~57 KB — some 180x this column's p99, on a column every model-feed row selects.
 * Ten trimmed ones hold it near 4 KB. The full set stays on the scan's own row.
 */
const MAX_PERSISTED_META_VERSIONS = 10;
const MAX_PERSISTED_VERSION_NAME_CHARS = 100;
const MAX_PERSISTED_VERSION_LABELS = 5;

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
  // Bounded at the write, not at one call site. Both callers reach this function, and the cap
  // enforced by only one of them is the cap that is not enforced.
  const boundedTerms = matchedTerms.slice(0, MAX_PERSISTED_META_ITEMS);

  // Database-side jsonb merge, not a read-modify-write of the whole object. A
  // `minorFlagSnapshot` written between the read and the write would otherwise be
  // erased, and that key is what gates the owner's appeal flow.
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      'textModeration', COALESCE(m.meta -> 'textModeration', '{}'::jsonb) || jsonb_build_object(
        'labels', ${labelsJson}::jsonb,
        'matchedTerms', to_jsonb(${boundedTerms}::text[]),
        'scannedAt', now()
      )
    )
    WHERE m.id = ${entityId}
  `;
}

/**
 * Version-name scan findings, recorded and not acted on.
 *
 * Recorded for review only: nothing sets `ModelVersion.nsfw` from THESE. The automatic
 * version-name path writes that column itself — see `model-version-moderation.adapter.ts`.
 * Lands under the model's `textModeration` key, which `stripMinorHashMeta` strips from every
 * creator-facing response, the owner's included.
 */
export async function recordModelVersionNameForensics({
  modelId,
  versions,
}: {
  modelId: number;
  versions: {
    versionId: number;
    name: string;
    labels: { label: string; score: number; threshold: number }[];
  }[];
}) {
  // Highest-scoring first, so a model with more flagged versions than the cap keeps the entries
  // a moderator would open rather than whichever came back first.
  const topScore = (v: { labels: { score: number }[] }) =>
    v.labels.length ? Math.max(...v.labels.map((l) => l.score)) : 0;
  const trimmed = [...versions]
    .sort((a, b) => topScore(b) - topScore(a))
    .slice(0, MAX_PERSISTED_META_VERSIONS)
    .map(({ versionId, name, labels }) => ({
      versionId,
      name: name.slice(0, MAX_PERSISTED_VERSION_NAME_CHARS),
      labels: [...labels].sort((a, b) => b.score - a.score).slice(0, MAX_PERSISTED_VERSION_LABELS),
    }));
  const versionsJson = JSON.stringify(trimmed);
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      'textModeration', COALESCE(m.meta -> 'textModeration', '{}'::jsonb) || jsonb_build_object(
        'versions', ${versionsJson}::jsonb,
        'versionsScannedAt', now()
      )
    )
    WHERE m.id = ${modelId}
  `;
}

/**
 * The NSFW flip, shared by the moderation callback and the operator harness.
 *
 * Both arrive with a verdict already rendered; what differs is how they got it, not what the
 * write has to do. The parts that are easiest to leave out of a second copy — the level
 * recompute that queues Meilisearch, the origin-side cache bust, the system attribution — are
 * exactly the parts nothing would report missing.
 *
 * The caller owns flag gating; this function has none. The harness runs in the situations the
 * flags are down for, which is the same exemption the backfill endpoint has.
 */
export async function applyModelTextNsfwFlag({
  entityId,
  triggeredLabels,
  matchedTerms,
  labels,
  source = 'xguard-text-moderation',
}: {
  entityId: number;
  triggeredLabels: string[];
  matchedTerms: string[];
  labels: { label: string; score: number; threshold: number }[];
  source?: string;
}): Promise<'applied' | 'repaired' | 'skipped_locked' | 'declined_race' | 'missing'> {
  const db = await getDbWithoutLag('model', entityId);
  const model = await db.model.findUnique({
    where: { id: entityId },
    select: { id: true, nsfw: true, nsfwLevel: true, lockedProperties: true, userId: true },
  });
  // Deleted between submit and callback — a bare update would throw P2025 and fail the
  // moderation callback, which the orchestrator would then retry forever.
  if (!model) return 'missing';

  // Recorded whether or not the flip happens, matching the profanity branch: a moderator
  // reviewing a model they already ruled on still needs to see that the scan disagreed.
  await recordForensics({ entityId, matchedTerms, labels });

  const stored = model.lockedProperties ?? [];
  // A stored lock is a moderator's call: minor-flagging sets nsfw:false and locks it.
  if (stored.includes('nsfw')) {
    // A prior callback may have written nsfw:true and died before recomputing levels —
    // EntityModeration is already Succeeded by then, so nothing else revisits the row.
    // Gated on the level actually being wrong: `updateModelNsfwLevels` matches every
    // `nsfw = true` row unconditionally, so calling it on a correct row still writes,
    // fires the model row trigger, and queues a Meilisearch re-render.
    if (model.nsfw && model.nsfwLevel !== nsfwBrowsingLevelsFlag) {
      await updateModelNsfwLevels([entityId]);
      recordModelTextModerationOutcome('repaired');
      return 'repaired';
    }
    recordModelTextModerationOutcome('skipped_locked');
    return 'skipped_locked';
  }

  // Guarded in the WHERE, not by the read above. The lock check and this write are two
  // statements, and a moderator ruling that lands between them would otherwise be
  // overwritten. `array_append` in the database for the same reason — writing back the
  // array we read would drop a concurrent lock on some other property.
  const flipped = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET nsfw = TRUE,
        "lockedProperties" = array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw')
    WHERE m.id = ${entityId}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
  `;

  if (!flipped) {
    recordModelTextModerationOutcome('declined_race');
    logToAxiom({
      name: 'model-text-moderation',
      type: 'warning',
      message: 'nsfw lock appeared between read and write; flag not applied',
      modelId: entityId,
    }).catch(() => null);
    return 'declined_race';
  }

  // Also queues the model's Meilisearch document — the search doc carries `nsfwLevel` and the
  // version names, and is what the site filters on.
  await updateModelNsfwLevels([entityId]);
  // The origin-side public response cache keys off browsing level and is otherwise only
  // busted by `upsertModel`. Without this the pre-flip payload keeps being served for the
  // whole TTL, including on the SFW-only key used for region-restricted requests.
  await bustPublicModelResponseCache(entityId);

  // Attribute the flip to the system rather than leaving it absent from the change
  // history — this write has no actor at all, so nothing else can.
  await new Tracker()
    .entityChanges(
      diffEntityChanges({
        entityType: 'Model',
        entityId,
        ownerId: model.userId,
        before: { nsfw: model.nsfw, lockedProperties: stored },
        after: { nsfw: true, lockedProperties: [...stored, 'nsfw'] },
        actorRole: 'system',
        systemFields: { nsfw: source, lockedProperties: source },
      })
    )
    .catch(() => null);

  recordModelTextModerationOutcome('applied');

  logToAxiom({
    name: 'model-text-moderation',
    type: 'info',
    message: 'nsfw flag applied',
    modelId: entityId,
    source,
    triggeredLabels,
    // Scores, not just names: during a ramp the question is whether flags are
    // landing near their thresholds (policy needs tuning) or far above them.
    labels,
  }).catch(() => null);

  return 'applied';
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
  isEnabled: ({ entityId }) => submitEnabled(entityId),

  submit: async ({ entityId, content }) => {
    // Gated as well as `isEnabled`: a caller that reaches the hook directly must not be
    // able to request a scan the flag has turned off. Undefined is contractual here —
    // the same shape as a submit the helper itself declined.
    if (!(await submitEnabled(entityId))) return undefined;
    return submitModelScan({ entityId, content });
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

    const matchedTerms = collectMatchedTerms(output, triggered);

    await applyModelTextNsfwFlag({
      entityId,
      triggeredLabels,
      matchedTerms,
      labels: triggeredLabelDetails(output, triggered),
    });
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
  if (!content) return;

  if (!(await submitEnabled(model.id))) return;

  try {
    await submitModelScan({ entityId: model.id, content });
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
 * which would never re-enter `applyResult`.
 */
export function submitModelTextModerationBackfill(model: {
  id: number;
  name: string;
  description?: string | null;
}) {
  const content = buildModelModerationText(model);
  if (!content) return null;
  return submitModelScan({ entityId: model.id, content, forceRescan: true });
}
