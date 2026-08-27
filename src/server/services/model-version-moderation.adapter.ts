import type { XGuardModerationOutput } from '@civitai/client';
import { Tracker } from '~/server/clickhouse/tracker';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
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
} from '~/server/services/model-moderation.labels';
import {
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';

export const MODEL_VERSION_MODERATION_ENTITY_TYPE = 'ModelVersion';

const LEVEL_LABEL_SET: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);

/**
 * Model VERSION name moderation.
 *
 * A version's name renders on civitai.com in places the model's own rating never reaches, and
 * nothing scanned it. This closes that.
 *
 * THE TERM LIST DECIDES, THE SCAN REVIEWS. A name matching a curated term is flagged on the
 * spot, at save time; XGuard then gets the same name and can overturn it. That order is
 * deliberate and it is the opposite of the model path's. XGuard reads a two-word title poorly —
 * it returns `suggestive` in the 0.55-0.69 band for strings as contentless as `v1.0` — so it is
 * not usable as the thing that decides. It is very good at the narrower question it is asked
 * here: given a name the list already matched, is the list wrong? Over the first full sweep it
 * overturned 24 of 2,620 matches and was right in all 24.
 *
 * So `applyResult` only ever CLEARS. Nothing downstream of the term list can raise the flag,
 * which is also why a moderator's decision cannot be undone by a callback arriving late.
 *
 * WHAT IS SCANNED: the version name, alone. Not the description — deliberately. The flag exists
 * because the NAME is what displays; including the description would make the verdict "is this
 * version adult", which is a different question and answers it wrongly in both directions. The
 * description is already scanned one layer up, where it sets `Model.nsfw` — and a flagged model
 * already stamps every version through the `m.nsfw` branch of the same CASE, so scanning it
 * here would double-count a signal we act on already.
 *
 * WHAT IT SETS: `ModelVersion.nsfw`, which is an INPUT to the version's derived `nsfwLevel`.
 * Nothing writes the level directly — the flag flips, a trigger enqueues a recompute, and the
 * derivation stamps it. That is also why no lock column is needed: a recompute cannot clobber a
 * flag it reads as its own input.
 *
 * FAILURE LEAVES THE FLAG ON. A submit that fails, or a callback that never arrives, means the
 * review never happens and the term list's verdict stands. That is the safe direction for this
 * feature, and it is why the moderator clear path exists rather than being optional.
 *
 * The callback is the shared one. Registering this adapter under `ModelVersion` is the whole
 * wiring — `/api/webhooks/text-moderation-result` dispatches by entityType, and the retry cron
 * reads the same registry.
 */

/**
 * Is version-name moderation active at all?
 *
 * The configured term list IS the off switch — empty selects nothing, so nothing is flagged,
 * scanned or cleared. It lives in sysRedis, so turning the feature off is a key edit rather
 * than a deploy, which is why there is no separate feature flag in front of it.
 */
async function submitEnabled() {
  const spec = await getModelVersionNameTerms();
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

/**
 * The one write, both directions. The term list raises the flag here and a scan that finds
 * nothing lowers it here, so the recompute, the attribution and the system-owned exclusion
 * cannot be present on one path and missing on the other.
 */
async function writeVersionNameFlag({
  versionId,
  nsfw,
  source,
}: {
  versionId: number;
  nsfw: boolean;
  source: string;
}): Promise<boolean> {
  const db = await getDbWithoutLag('modelVersion', versionId);
  const version = await db.modelVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      nsfw: true,
      meta: true,
      modelId: true,
      model: { select: { userId: true } },
    },
  });
  // Deleted between submit and callback — a bare update would throw P2025 and fail the
  // callback, which the orchestrator would then retry forever.
  if (!version) return false;
  if (version.nsfw === nsfw) return false;

  // A moderator has ruled; neither the term list nor the scan may overturn it. Checked here
  // rather than at the two call sites because BOTH unattended paths reach this function, and a
  // guard on one of them is the guard that is not enforced. `setModelVersionNsfw` writes its own
  // statement and is deliberately not subject to this.
  if ((version.meta as ModelVersionMeta | null)?.nsfwDecision) {
    logToAxiom({
      name: 'model-version-name-moderation',
      type: 'info',
      message: 'moderator ruling stands; automatic write declined',
      modelVersionId: versionId,
      source,
      wouldHaveSet: nsfw,
    }).catch(() => null);
    return false;
  }

  // Guarded in the WHERE rather than by the read above, and scoped away from system-owned
  // models in BOTH directions. Raising the flag there is refused by a database trigger.
  // Lowering it is not refused, and is worse: the level derivation has no branch for an
  // unflagged system-owned version, so the row would keep the NSFW level with the flag gone
  // and nothing would ever revisit it.
  const flipped = await dbWrite.$executeRaw`
    UPDATE "ModelVersion" mv
    SET nsfw = ${nsfw}
    FROM "Model" m
    WHERE mv.id = ${versionId}
      AND m.id = mv."modelId"
      AND m."userId" > -1
      AND mv.nsfw = ${!nsfw}
      AND mv.meta -> 'nsfwDecision' IS NULL
  `;
  if (!flipped) return false;

  // The trigger enqueues the recompute, but that is up to a minute away. Recomputing inline
  // makes the change visible immediately; the trigger stays as the backstop for every writer
  // that is not this one. The model rollup too — under the `safeCount` branch a version
  // arriving or leaving the flagged set can move the model's own level.
  await updateModelVersionNsfwLevels([versionId]);
  await updateModelNsfwLevels([version.modelId]);

  await new Tracker()
    .entityChanges(
      diffEntityChanges({
        entityType: 'ModelVersion',
        entityId: versionId,
        ownerId: version.model.userId,
        before: { nsfw: !nsfw },
        after: { nsfw },
        actorRole: 'system',
        systemFields: { nsfw: source },
      })
    )
    .catch(() => null);

  return true;
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

  // Clear-only. The term list has already ruled by the time this runs; the scan's job is to
  // find the cases where it was wrong.
  //
  // `output.blocked` is deliberately unread, same as the model adapter: the submit sends
  // fifteen labels this path does not act on, several with Block actions orchestrator-side, so
  // honouring `blocked` would let an unacted label speak for the level labels.
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

    // XGuard's own per-label thresholds, with no floor on top of them. A floor belongs on the
    // path where the classifier DECIDES; here it only ever overturns, and the same comparison
    // the sweep measured its 24-for-24 record on is the one that belongs in the product.
    if (levelLabels.length) return;

    const cleared = await writeVersionNameFlag({
      versionId: entityId,
      nsfw: false,
      source: 'xguard-version-name-review',
    });
    if (!cleared) return;

    logToAxiom({
      name: 'model-version-name-moderation',
      type: 'info',
      message: 'term-list flag overturned by scan',
      modelVersionId: entityId,
      labels,
    }).catch(() => null);
  },

  // No applyFailure. A terminal failure leaves the term list's flag standing, which is the safe
  // direction — the review simply did not happen. The omission is deliberate; do not add an
  // empty hook.
};

/**
 * Re-evaluates a version's name and submits it for review. Called on create and on rename.
 *
 * Awaited by `upsertModelVersion`: it swallows every error, so the save cannot fail on a scan,
 * and completing before the response means a frozen runtime cannot drop the submit.
 *
 * The flag is a function of the CURRENT name, so a rename re-decides from scratch in both
 * directions — a name the list no longer matches is a name a fresh create would not be flagged
 * for. That is a clear on the same evidence the flag was set on, not a creator-driven override.
 */
export async function moderateModelVersionName(version: {
  id: number;
  name?: string | null;
  isModerator?: boolean;
}): Promise<void> {
  // Same carve-out as the model path: a moderator editing a name is making a decision, and an
  // unattended pass must not re-flip it.
  if (version.isModerator) return;

  const name = version.name?.trim();
  if (!name) return;

  try {
    // Before the match, not after: an unconfigured list means the feature is off, which has to
    // stop the clear as well as the flag. `matchModelVersionNameTerms` returns nothing in both
    // cases and cannot tell them apart.
    if (!(await submitEnabled())) return;

    const matched = await matchModelVersionNameTerms(name);
    if (!matched.length) {
      await writeVersionNameFlag({
        versionId: version.id,
        nsfw: false,
        source: 'version-name-terms',
      });
      return;
    }

    const flagged = await writeVersionNameFlag({
      versionId: version.id,
      nsfw: true,
      source: 'version-name-terms',
    });
    if (flagged)
      logToAxiom({
        name: 'model-version-name-moderation',
        type: 'info',
        message: 'flagged by term list; awaiting review',
        modelVersionId: version.id,
        matched,
      }).catch(() => null);

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
