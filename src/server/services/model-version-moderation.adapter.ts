import type { XGuardModerationOutput } from '@civitai/client';
import { Tracker } from '~/server/clickhouse/tracker';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import {
  getModelVersionNameTerms,
  matchModelVersionNameTerms,
} from '~/server/services/model-version-name-terms.service';
import {
  triggeredLabelDetails,
  triggeredLabelKeys,
} from '~/server/services/moderation-label-helpers';
import {
  MODEL_MODERATION_LEVEL_LABELS,
  MODEL_MODERATION_SCAN_LABELS,
} from '~/server/services/model-moderation.adapter';
import { updateModelVersionNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';

export const MODEL_VERSION_MODERATION_ENTITY_TYPE = 'ModelVersion';

const LEVEL_LABEL_SET: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);

/**
 * Model VERSION name moderation.
 *
 * A version's name renders on civitai.com in places the model's own rating never reaches, and
 * nothing scanned it. This closes that: on create or rename, the name is matched against a
 * curated term list, and only a match is worth an XGuard call.
 *
 * WHAT IS SCANNED: the version name, alone. Not the description — deliberately. The flag exists
 * because the NAME is what displays; including the description would make the verdict "is this
 * version adult", which is a different question and answers it wrongly in both directions. The
 * description is already scanned one layer up, where it sets `Model.nsfw` — and a flagged model
 * already stamps every version through the `m.nsfw` branch of the same CASE, so scanning it
 * here would double-count a signal we act on already. Only about a quarter have one (plan §5.1), so
 * including it would make the flag mean different things for different creators.
 *
 * WHAT IT SETS: `ModelVersion.nsfw`, which is an INPUT to the version's derived `nsfwLevel`.
 * Nothing writes the level directly — the flag flips, a trigger enqueues a recompute, and the
 * derivation stamps it. That is also why no lock column is needed: a recompute cannot clobber a
 * flag it reads as its own input.
 *
 * The callback is the shared one. Registering this adapter under `ModelVersion` is the whole
 * wiring — `/api/webhooks/text-moderation-result` dispatches by entityType, and the retry cron
 * reads the same registry.
 */

/**
 * Is version-name moderation active at all?
 *
 * The configured term list IS the off switch — empty selects nothing, so nothing is scanned and
 * nothing is flagged. It lives in sysRedis, so turning the feature off is a key edit rather than
 * a deploy, which is why there is no separate feature flag in front of it.
 */
async function submitEnabled() {
  const { spec } = await getModelVersionNameTerms();
  return spec.triggers.length > 0;
}

/**
 * The one place a version-name scan is requested — the write path and the retry cron both reach
 * it, and a divergence between them changes what lands in the audit corpus without failing.
 */
function submitVersionScan({ entityId, content }: { entityId: number; content: string }) {
  return submitTextModeration({
    entityType: MODEL_VERSION_MODERATION_ENTITY_TYPE,
    entityId,
    content,
    labels: [...MODEL_MODERATION_SCAN_LABELS],
    priority: 'low',
    recordForReview: true,
  });
}

export const modelVersionModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.modelVersion.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.filter((r) => !!r.name?.trim()).map((r) => [r.id, r.name.trim()]));
  },

  // Lets the retry cron skip these rows wholesale while the feature is dark, BEFORE it spends
  // their retry budget — a declined submit is indistinguishable from a failed one.
  isEnabled: () => submitEnabled(),

  submit: async ({ entityId, content }) => {
    if (!(await submitEnabled())) return undefined;
    return submitVersionScan({ entityId, content });
  },

  // `output.blocked` is deliberately unread, same as the model adapter: the submit sends fifteen
  // labels this path does not act on, several with Block actions orchestrator-side, so honouring
  // `blocked` would let an unacted label set the flag. Recompute from the level labels instead.
  applyResult: async ({ entityId, triggeredLabels: callbackLabels, output }) => {
    const triggered = triggeredLabelKeys(
      {
        results: output?.results as XGuardModerationOutput['results'],
        triggeredLabels: [...(callbackLabels ?? []), ...(output?.triggeredLabels ?? [])],
      },
      { includeScoreThreshold: true }
    );
    const labels = triggeredLabelDetails(
      { results: output?.results as XGuardModerationOutput['results'] },
      triggered
    );
    const levelLabels = labels.filter((l) => LEVEL_LABEL_SET.has(l.label));
    if (!levelLabels.length) return;

    // The score floor, not just "a level label fired": XGuard's own thresholds are not usable
    // on strings this short. Measurement lives with DEFAULT_MIN_SCORE.
    const { config } = await getModelVersionNameTerms();
    const topScore = Math.max(...levelLabels.map((l) => l.score));
    if (topScore < config.minScore) {
      logToAxiom({
        name: 'model-version-name-moderation',
        type: 'info',
        message: 'below score floor; not applied',
        modelVersionId: entityId,
        topScore,
        minScore: config.minScore,
        labels: levelLabels,
      }).catch(() => null);
      return;
    }

    const db = await getDbWithoutLag('modelVersion', entityId);
    const version = await db.modelVersion.findUnique({
      where: { id: entityId },
      select: {
        id: true,
        name: true,
        nsfw: true,
        modelId: true,
        model: { select: { userId: true } },
      },
    });
    // Deleted between submit and callback — a bare update would throw P2025 and fail the
    // callback, which the orchestrator would then retry forever.
    if (!version) return;
    if (version.nsfw) return;

    // Guarded in the WHERE rather than by the read above, and scoped away from system-owned
    // models. The level derivation has no branch for an unflagged system-owned version, so
    // setting the flag there is a one-way door — a database trigger refuses it outright, and
    // this predicate keeps the callback from tripping that and failing the whole webhook.
    const flipped = await dbWrite.$executeRaw`
      UPDATE "ModelVersion" mv
      SET nsfw = TRUE
      FROM "Model" m
      WHERE mv.id = ${entityId}
        AND m.id = mv."modelId"
        AND m."userId" > -1
        AND mv.nsfw = FALSE
    `;
    if (!flipped) return;

    // The trigger enqueues the recompute, but that is up to a minute away. Recomputing inline
    // makes the change visible immediately; the trigger stays as the backstop for every writer
    // that is not this one.
    await updateModelVersionNsfwLevels([entityId]);

    await new Tracker()
      .entityChanges(
        diffEntityChanges({
          entityType: 'ModelVersion',
          entityId,
          ownerId: version.model.userId,
          before: { nsfw: false },
          after: { nsfw: true },
          actorRole: 'system',
          systemFields: { nsfw: 'xguard-version-name-moderation' },
        })
      )
      .catch(() => null);

    logToAxiom({
      name: 'model-version-name-moderation',
      type: 'info',
      message: 'nsfw flag applied',
      modelVersionId: entityId,
      modelId: version.modelId,
      topScore,
      labels: levelLabels,
    }).catch(() => null);
  },

  // No applyFailure. A version's visibility does not gate on its name scan, so a terminal
  // failure leaves it as-is and the EntityModeration row is enough for the retry cron. The
  // omission is deliberate — do not add an empty hook.
};

/**
 * Fire-and-forget submit for the version write path. Owns its own term gate, flag check and
 * error handling so `upsertModelVersion` gets a single awaitable that can never fail the save.
 *
 * The term gate is what makes this affordable on every save: it is a local regex pass, and it
 * keeps the LLM off the overwhelming majority of names, which are `v1.0` and carry no content
 * for a classifier to read.
 */
export async function submitModelVersionNameModeration(version: {
  id: number;
  name?: string | null;
  isModerator?: boolean;
}): Promise<void> {
  // Same carve-out as the model path: a moderator editing a name is making a decision, and an
  // unattended scan must not re-flip it.
  if (version.isModerator) return;

  const name = version.name?.trim();
  if (!name) return;

  try {
    const matched = await matchModelVersionNameTerms(name);
    if (!matched.length) return;
    if (!(await submitEnabled())) return;
    await submitVersionScan({ entityId: version.id, content: name });
  } catch (e) {
    logToAxiom({
      name: 'model-version-name-moderation',
      type: 'error',
      message: (e as Error).message,
      modelVersionId: version.id,
    }).catch(() => null);
  }
}
