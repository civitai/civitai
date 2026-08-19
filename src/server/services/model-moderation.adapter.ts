import { uniq } from 'lodash-es';
import type { XGuardModerationOutput } from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import type { ModelMeta } from '~/server/schema/model.schema';
import { removeTags } from '~/utils/string-helpers';

export const MODEL_MODERATION_ENTITY_TYPE = 'Model';

/**
 * Every label submitted on a model scan. Twelve of them are recorded and not acted on —
 * their trigger rates on real model text are the input to deciding what a v2 acts on, and
 * there is no way to collect them without scanning.
 *
 * Owned here rather than imported from `blocks/steps/text-output-moderation`: per-consumer
 * label selection is the pattern (Article sends one, Challenge two, wildcard a fail set plus
 * a level set), and importing that list would point a dependency at App Blocks.
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
 * `triggeredLabels` and `results[].triggered`/`score` are two views of the same fact from a
 * service on the other side of a network boundary (see `wildcard-category-audit.service.ts`
 * and `text-output-moderation.ts`'s `decideTextOutputVerdict`); union rather than pick one, so
 * a level label that only shows up in one view still counts as triggered.
 */
export function isModelTextNsfw({
  triggeredLabels,
  results,
}: {
  triggeredLabels?: string[];
  results?: XGuardModerationOutput['results'];
}): boolean {
  if ((triggeredLabels ?? []).some((label) => LEVEL_LABEL_SET.has(label.toLowerCase()))) {
    return true;
  }
  return (results ?? []).some((r) => {
    if (!LEVEL_LABEL_SET.has(r.label.toLowerCase())) return false;
    return r.triggered === true || (typeof r.score === 'number' && r.score >= r.threshold);
  });
}

/**
 * Requested labels absent from `results[]` — a rename/typo drift the same shape as
 * `text-output-moderation.ts`'s `missingRequestedLabels` guards. Absence, not a low score,
 * means the scanner never answered on that label; a 0% trigger rate produced by that is a
 * measurement gap, not a finding.
 */
function missingScanLabels(results: XGuardModerationOutput['results'] | undefined): string[] {
  const evaluated = new Set((results ?? []).map((r) => r.label.toLowerCase()));
  return MODEL_MODERATION_SCAN_LABELS.filter((label) => !evaluated.has(label.toLowerCase()));
}

/**
 * Union of `matchedTerms.text` across the labels that actually triggered. The webhook passes the
 * raw `XGuardModerationOutput`, whose `results` cover all 15 submitted labels — not just the ones
 * that fired — so the `triggered` filter below is load-bearing, not defensive.
 */
function collectMatchedTerms({
  results,
  triggeredLabels,
}: Pick<XGuardModerationOutput, 'results' | 'triggeredLabels'>): string[] {
  const triggered = new Set((triggeredLabels ?? []).map((l) => l.toLowerCase()));
  return uniq(
    (results ?? [])
      .filter((r) => triggered.has(r.label.toLowerCase()))
      .flatMap((r) => r.matchedTerms?.text ?? [])
  );
}

export const modelModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.model.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, description: true },
    });
    return new Map(rows.map((r) => [r.id, buildModelModerationText(r)]));
  },

  // Gated on the submit flag: the retry cron reaches this same hook, and off must mean "no
  // scan is requested at all," not just "upsertModel stops asking." Undefined is a contractual
  // return per `ModerationAdapter.submit` — same shape as a submit the helper itself declined.
  submit: async ({ entityId, content }) => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD, String(entityId))))
      return undefined;

    return submitTextModeration({
      entityType: MODEL_MODERATION_ENTITY_TYPE,
      entityId,
      content,
      labels: [...MODEL_MODERATION_SCAN_LABELS],
      priority: 'low',
      recordForReview: true,
    });
  },

  // `output.blocked` is deliberately unread. The submit sends fifteen labels this adapter does
  // not act on beyond the three level labels, several with Block or Review actions
  // orchestrator-side, so honouring `blocked` would let an unacted label change the outcome.
  // Recompute locally from the level labels instead.
  applyResult: async ({ entityId, triggeredLabels, output }) => {
    const missingLabels = missingScanLabels(output.results);
    if (missingLabels.length) {
      logToAxiom({
        name: 'model-text-moderation',
        type: 'warning',
        message: 'requested label missing from scan results',
        modelId: entityId,
        missingLabels,
      }).catch(() => null);
    }

    if (!isModelTextNsfw({ triggeredLabels, results: output.results })) return;

    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD_APPLY, String(entityId))))
      return;

    const db = await getDbWithoutLag('model', entityId);
    const model = await db.model.findUnique({
      where: { id: entityId },
      select: { id: true, nsfw: true, lockedProperties: true, meta: true, userId: true },
    });
    // Deleted between submit and callback — a bare update would throw P2025 and fail the
    // moderation callback, which the orchestrator would then retry forever.
    if (!model) return;

    const stored = model.lockedProperties ?? [];
    // A stored lock is a moderator's call: minor-flagging sets nsfw:false and locks it.
    // Same condition the profanity branch uses, so behaviour is identical to today.
    if (stored.includes('nsfw')) {
      // A prior call may have written nsfw:true and then died before this ran — EntityModeration
      // is already Succeeded by then, so nothing else revisits the row. Repair the drift on any
      // replayed callback; idempotent single-row SQL, so a no-op when nsfw is already false.
      if (model.nsfw) await updateModelNsfwLevels([entityId]);
      return;
    }

    const meta = (model.meta ?? {}) as ModelMeta;
    const nextMeta: ModelMeta = {
      ...meta,
      textModeration: {
        matchedTerms: collectMatchedTerms(output),
        triggeredLabels: triggeredLabels ?? [],
        scannedAt: new Date().toISOString(),
      },
    };

    await dbWrite.model.update({
      where: { id: entityId },
      data: {
        nsfw: true,
        lockedProperties: uniq([...stored, 'nsfw']),
        meta: nextMeta,
      },
    });

    await updateModelNsfwLevels([entityId]);

    logToAxiom({
      name: 'model-text-moderation',
      type: 'info',
      message: 'nsfw flag applied',
      modelId: entityId,
      triggeredLabels,
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
  if (!content) return;

  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD, String(model.id)))) return;

  try {
    await submitTextModeration({
      entityType: MODEL_MODERATION_ENTITY_TYPE,
      entityId: model.id,
      content,
      labels: [...MODEL_MODERATION_SCAN_LABELS],
      priority: 'low',
      recordForReview: true,
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
