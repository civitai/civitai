import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { constants, requiresPrePublishReview } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import {
  decidePrePublishGate,
  PENDING_IMAGE_MAX_AGE_MS,
  type TextVerdict,
} from '~/server/services/pre-publish-gate/evaluate';
import {
  GATE_HELD_MESSAGE,
  GATE_REFUSAL_MESSAGES,
} from '~/server/services/pre-publish-gate/messages';
import type {
  GateDecision,
  GateScope,
  PrePublishGateMeta,
} from '~/server/services/pre-publish-gate/types';
import { hasOpenTextScanFlag } from '~/server/services/text-scan/flag-snapshot';
import { loadModelPrePublishSubjects } from '~/server/services/text-scan/profiles/model-pre-publish.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { unpublishModelById } from '~/server/services/model.service';
import { scanEntity } from '~/server/services/text-scan/submit';
import { heldVersionWhere, isMetaDeclined } from '~/server/services/pre-publish-gate/held';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
} from '~/server/utils/errorHandling';
import { NotificationCategory } from '~/server/common/enums';
import { createNotification } from '~/server/services/notification.service';
import { logToAxiom } from '~/server/logging/client';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

const TEXT_SCAN_ENTITY_TYPE = 'ModelPrePublish';

/**
 * The versions of this publish the gate covers: the listed ones, or, for a publish that lists none,
 * every version of the model. Empty when none is on a gated base model.
 */
export async function getGatedVersionIds(
  modelId: number,
  versionIds?: number[],
  { modelGoesPublic = false }: { modelGoesPublic?: boolean } = {}
) {
  const versions = await dbWrite.modelVersion.findMany({
    where: {
      modelId,
      ...(versionIds?.length
        ? // A model going public takes its already-published versions with it, listed or not.
          modelGoesPublic
          ? {
              OR: [
                { id: { in: versionIds } },
                { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
              ],
            }
          : { id: { in: versionIds } }
        : { status: { not: ModelStatus.Deleted } }),
    },
    select: { id: true, baseModel: true },
  });
  return versions.filter((v) => requiresPrePublishReview(v.baseModel)).map((v) => v.id);
}

/** The gate's real-person scan of the model text as it is now; submits one when there is none. */
async function readTextVerdict(modelId: number): Promise<TextVerdict> {
  const subject = (await loadModelPrePublishSubjects([modelId])).get(modelId);
  if (!subject) return 'unavailable';
  const textHash = textScanTextHash(subject);
  const readRow = () =>
    dbWrite.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: TEXT_SCAN_ENTITY_TYPE, entityId: modelId } },
      select: { status: true, triggeredLabels: true, result: true },
    });
  const verdictOf = (row: Awaited<ReturnType<typeof readRow>>) =>
    row?.triggeredLabels.includes('poi') ? 'hit' : 'clear';
  const row = await readRow();
  if (row?.status === 'Succeeded' && (row.result as { textHash?: string })?.textHash === textHash)
    return verdictOf(row);
  const submitted = await scanEntity({ entityType: TEXT_SCAN_ENTITY_TYPE, entityId: modelId });
  if (submitted.status === 'submitted') return 'pending';
  if (submitted.status === 'skipped' && submitted.reason === 'in-flight') return 'pending';
  // The scan judged this exact text already.
  if (submitted.status === 'skipped' && submitted.reason === 'unchanged') {
    const latest = await readRow();
    if (latest?.status === 'Succeeded') return verdictOf(latest);
  }
  return 'unavailable';
}

export async function evaluatePrePublishGate(
  modelId: number,
  gatedVersionIds: number[],
  { now = new Date(), requestedAt }: { now?: Date; requestedAt?: Date } = {}
): Promise<GateDecision> {
  const model = await dbWrite.model.findUniqueOrThrow({
    where: { id: modelId },
    select: { nsfw: true, poi: true, meta: true, userId: true },
  });
  const images = await dbWrite.image.findMany({
    where: { post: { modelVersionId: { in: gatedVersionIds }, userId: model.userId } },
    select: {
      id: true,
      ingestion: true,
      nsfwLevel: true,
      minor: true,
      poi: true,
      needsReview: true,
      createdAt: true,
    },
  });
  // A refused model needs no text scan, so none is billed for it.
  let textVerdict: TextVerdict = model.nsfw ? 'pending' : await readTextVerdict(modelId);
  // A scan that never answers goes to a moderator rather than leaving the model waiting.
  if (
    textVerdict === 'pending' &&
    requestedAt &&
    now.getTime() - requestedAt.getTime() > PENDING_IMAGE_MAX_AGE_MS
  )
    textVerdict = 'unavailable';
  return decidePrePublishGate({
    model: {
      nsfw: model.nsfw,
      poi: model.poi,
      poiFlagOpen: hasOpenTextScanFlag(model.meta, 'poi'),
    },
    images,
    textVerdict,
    now,
  });
}

const summaryOf = (decision: GateDecision, deferred: boolean) => [
  ...decision.checks.map((c) => `${c.check}:${c.outcome}`),
  `gate:${decision.outcome}${deferred ? ':scheduled' : ''}`,
];

async function readGateMeta(modelId: number) {
  const row = await dbWrite.model.findUnique({ where: { id: modelId }, select: { meta: true } });
  return ((row?.meta as Record<string, unknown> | null)?.prePublishGate ??
    null) as PrePublishGateMeta | null;
}

async function waitingRunMessage(modelId: number, versionIds: number[]) {
  const names = versionIds.length
    ? (
        await dbWrite.modelVersion.findMany({
          where: { id: { in: versionIds }, modelId },
          select: { name: true },
        })
      ).map((v) => `"${v.name}"`)
    : [];
  const waiting = names.length ? names.join(', ') : 'An earlier publish of this model';
  return `${waiting} is waiting for its checks and will publish automatically when they finish. Try this publish again after that.`;
}

async function writeGateMeta(modelId: number, gate: PrePublishGateMeta) {
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = ${asJsonbObjectSql('meta')} || jsonb_build_object('prePublishGate', ${JSON.stringify(
    gate
  )}::jsonb)
    WHERE id = ${modelId}
  `;
}

/** One row per check, written only when a run's results change, so a waiting re-check is quiet. */
async function logDecision(
  modelId: number,
  runId: string,
  decision: GateDecision,
  previous: PrePublishGateMeta | null,
  deferred: boolean
) {
  const summary = summaryOf(decision, deferred);
  if (previous?.runId === runId && previous.summary?.join() === summary.join()) return summary;
  await dbWrite.modelPublishCheck.createMany({
    data: [
      ...decision.checks.map((c) => ({
        modelId,
        runId,
        check: c.check,
        outcome: c.outcome,
        detail: (c.detail ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      })),
      {
        modelId,
        runId,
        check: 'gate',
        outcome: decision.outcome,
        detail: (decision.refusal
          ? { refusal: decision.refusal }
          : deferred
          ? { scheduled: true }
          : Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
      },
    ],
  });
  return summary;
}

async function holdForModerator(
  modelId: number,
  gatedVersionIds: number[],
  gate: PrePublishGateMeta
) {
  const model = await dbWrite.model.findUniqueOrThrow({
    where: { id: modelId },
    select: { status: true, availability: true },
  });
  const live =
    (model.status === ModelStatus.Published || model.status === ModelStatus.Scheduled) &&
    model.availability !== Availability.Private;
  if (live) {
    // Only the new version waits, in the moderator's needs-review queue; the live model stays up.
    await dbWrite.$executeRaw`
      UPDATE "ModelVersion"
      SET meta = ${asJsonbObjectSql('meta')} || '{"needsReview": true}'::jsonb
      WHERE id IN (${Prisma.join(gatedVersionIds)}) AND "modelId" = ${modelId}
    `;
    await writeGateMeta(modelId, gate);
    return false;
  }
  if (model.availability === Availability.Private) {
    // Stays private, and so usable by its owner, in the moderator's needs-review queue.
    await dbWrite.$executeRaw`
      UPDATE "Model"
      SET meta = ${asJsonbObjectSql('meta')} || jsonb_build_object(
        'needsReview', true, 'prePublishHold', true, 'prePublishGate', ${JSON.stringify(
          gate
        )}::jsonb
      )
      WHERE id = ${modelId}
    `;
    return false;
  }
  // The take-down notifies the owner, with this message.
  await unpublishModelById({
    id: modelId,
    userId: constants.system.user.id,
    isModerator: true,
    reason: 'other',
    customMessage: GATE_HELD_MESSAGE,
    metaPatch: { needsReview: true, prePublishGate: gate },
  });
  return true;
}

type ResolverOutcome =
  | { outcome: 'held' | 'unfinished' }
  | { outcome: 'refused'; refusal?: string };

/**
 * The owner was told at publish that the model would go live once the checks passed. When the
 * resolver's re-check ends the run another way, they are told, once per run.
 */
async function notifyOwnerOfResolverOutcome(
  modelId: number,
  runId: string,
  result: ResolverOutcome
) {
  // The outcome is already decided and written; a failed notice must not change it.
  try {
    const model = await dbWrite.model.findUnique({
      where: { id: modelId },
      select: { userId: true, name: true },
    });
    if (!model) return;
    await createNotification({
      userId: model.userId,
      type: 'pre-publish-gate-result',
      category: NotificationCategory.System,
      key: `pre-publish-gate-result:${runId}`,
      details: { modelId, modelName: model.name, ...result },
    });
  } catch (error) {
    logToAxiom({
      name: 'pre-publish-gate',
      type: 'error',
      message: 'owner notice failed',
      modelId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
  }
}

export type GateResult = {
  outcome: 'pass' | 'pending' | 'held';
  runId: string;
  /** The versions it judged; the publish write refuses any other that is gated by then. */
  versionIds: number[];
};

/**
 * Runs the gate for an owner's publish. Null when nothing in it is on a gated base model. A refusal
 * throws with the owner's message; a hold takes the model (or, on a live model, the new version) to
 * a moderator. Anything that throws leaves the publish refused: the gate never fails open.
 */
export async function enforcePrePublishGate({
  modelId,
  versionIds,
  scope,
  publishedAt,
  runId: resumedRunId,
  publishVersions,
}: {
  modelId: number;
  versionIds?: number[];
  scope: GateScope;
  publishedAt?: Date | null;
  /** The resolver's re-check of a waiting run; an owner's publish starts a new one. */
  runId?: string;
  publishVersions?: boolean;
}): Promise<GateResult | null> {
  // A model a moderator holds waits for them whatever this publish lists.
  const modelHold = await modelHoldState(modelId);
  if (modelHold)
    throw throwAuthorizationError(
      modelHold === 'declined'
        ? 'Our team declined to make this model public.'
        : 'This model is waiting for a review by our team.'
    );
  const gatedVersionIds = await getGatedVersionIds(modelId, versionIds, {
    modelGoesPublic: scope !== 'version',
  });
  if (!gatedVersionIds.length) {
    // The resolver's run no longer covers a gated version: it publishes as any other, and ends.
    if (resumedRunId) await closeWaitingGate(modelId, resumedRunId);
    return null;
  }

  // Whatever the path, nothing a moderator holds is re-checked for its owner: it waits for them.
  if (await isHeldForModerator(modelId, gatedVersionIds))
    throw throwAuthorizationError('This model is waiting for a review by our team.');

  const previous = await readGateMeta(modelId);
  const runId = resumedRunId ?? randomUUID();
  const resumed = !!resumedRunId && previous?.runId === resumedRunId;
  // A model keeps one waiting run, and a new one would replace it: the earlier ask would never publish.
  // One for a later date is the owner's to replace, by publishing now, at another date or another version.
  const scheduled = (previous?.publishedAtMs ?? 0) > Date.now();
  if (previous?.state === 'pending' && !resumed && !scheduled)
    throw throwConflictError(await waitingRunMessage(modelId, previous.versionIds));
  const requestedAt = resumed && previous ? previous.requestedAt : new Date().toISOString();
  const decision = await evaluatePrePublishGate(modelId, gatedVersionIds, {
    requestedAt: new Date(requestedAt),
  });
  // A pass for a later date is checked again when that date comes, so an edit in between is seen.
  const deferred = decision.outcome === 'pass' && !!publishedAt && publishedAt > new Date();
  const summary = await logDecision(modelId, runId, decision, previous, deferred);
  const gate: PrePublishGateMeta = {
    state: deferred ? 'pending' : decision.outcome === 'pass' ? 'passed' : decision.outcome,
    runId,
    // The resolver's failed passes count across its re-checks, so a run that keeps failing ends.
    ...(resumed && previous?.attempts ? { attempts: previous.attempts } : {}),
    scope,
    // As asked: the resolver asks again the same way, never for more.
    versionIds: versionIds ?? [],
    ...(publishedAt
      ? { publishedAt: publishedAt.toISOString(), publishedAtMs: publishedAt.getTime() }
      : {}),
    requestedAt,
    ...(decision.refusal ? { refusal: decision.refusal } : {}),
    ...(publishVersions !== undefined ? { publishVersions } : {}),
    summary,
    // Accumulates across runs. Outside the gate only the scheduled job reads it, and only a moderator
    // can schedule a gated version: an owner's later date waits in pending. A new path to Scheduled
    // must run the gate, not read this.
    passedVersionIds: [
      ...new Set([
        ...(previous?.passedVersionIds ?? []),
        ...(decision.outcome === 'pass' && !deferred ? gatedVersionIds : []),
      ]),
    ],
  };

  // Only the resolver's re-check of a run still waiting ends it out of the owner's sight.
  const endsWaitingRun = resumed && previous?.state === 'pending';
  if (decision.outcome === 'held') {
    const ownerTold = await holdForModerator(modelId, gatedVersionIds, gate);
    if (endsWaitingRun && !ownerTold)
      await notifyOwnerOfResolverOutcome(modelId, runId, { outcome: 'held' });
    return { outcome: 'held', runId, versionIds: gatedVersionIds };
  }
  await writeGateMeta(modelId, gate);
  if (decision.outcome === 'refused') {
    if (endsWaitingRun)
      await notifyOwnerOfResolverOutcome(modelId, runId, {
        outcome: 'refused',
        refusal: decision.refusal ?? 'images',
      });
    throw throwBadRequestError(GATE_REFUSAL_MESSAGES[decision.refusal ?? 'images']);
  }
  return { outcome: deferred ? 'pending' : decision.outcome, runId, versionIds: gatedVersionIds };
}

/**
 * A moderator publishing a gated model is not gated: it is the release, and it is logged as the
 * evidence of review. A version the gate held is taken off the needs-review queue.
 */
type ModeratorRelease = {
  modelId: number;
  versionIds?: number[];
  actorId: number;
  /** The moderator made the model itself public (not one version): that ends a model hold. */
  releasesModel?: boolean;
};

/** Runs after the publish committed: a failure is logged, so the publish's side effects still run. */
export async function recordModeratorRelease(release: ModeratorRelease) {
  try {
    await writeModeratorRelease(release);
  } catch (error) {
    logToAxiom({
      name: 'pre-publish-gate',
      type: 'error',
      message: 'moderator release record failed',
      modelId: release.modelId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
  }
}

async function writeModeratorRelease({
  modelId,
  versionIds,
  actorId,
  releasesModel = false,
}: ModeratorRelease) {
  // The log keeps any decline the release overrides: the marks that recorded it are cleared below.
  const declineOf = (meta: unknown) => {
    const m = (meta ?? {}) as Record<string, unknown>;
    return isMetaDeclined(m)
      ? {
          overrodeDecline: {
            reason: m.declinedReason ?? null,
            at: m.declinedAt ?? m.decliendAt ?? null,
          },
        }
      : undefined;
  };
  if (releasesModel) {
    const model = await dbWrite.model.findUnique({
      where: { id: modelId },
      select: { meta: true },
    });
    const held = (model?.meta as { prePublishHold?: boolean } | null)?.prePublishHold === true;
    if (held) {
      // Whatever versions are left on a gated base; a decline it overrides goes with it.
      await dbWrite.modelPublishCheck.create({
        data: {
          modelId,
          runId: (await readGateMeta(modelId))?.runId ?? randomUUID(),
          check: 'moderator_release',
          outcome: 'released',
          actorId,
          detail: (declineOf(model?.meta) ?? { model: true }) as Prisma.InputJsonValue,
        },
      });
      await dbWrite.$executeRaw`
        UPDATE "Model"
        SET meta = ${asJsonbObjectSql('meta')}
          - 'needsReview' - 'prePublishHold' - 'declinedReason' - 'declinedAt'
        WHERE id = ${modelId} AND meta ? 'prePublishHold'
      `;
    }
  }
  const gatedVersionIds = await getGatedVersionIds(modelId, versionIds);
  if (!gatedVersionIds.length) return;
  const previous = await readGateMeta(modelId);
  const runId = previous?.runId ?? randomUUID();
  const released = await dbWrite.modelVersion.findMany({
    where: { id: { in: gatedVersionIds }, modelId },
    select: { id: true, meta: true },
  });
  const metaById = new Map(released.map((v) => [v.id, v.meta]));
  await dbWrite.modelPublishCheck.createMany({
    data: gatedVersionIds.map((modelVersionId) => ({
      modelId,
      modelVersionId,
      runId,
      check: 'moderator_release',
      outcome: 'released',
      actorId,
      ...(declineOf(metaById.get(modelVersionId))
        ? { detail: declineOf(metaById.get(modelVersionId)) as Prisma.InputJsonValue }
        : {}),
    })),
  });
  // A release ends the version's hold and any decline of it, or a later model publish would read
  // the decline as a hold no moderator queue shows.
  await dbWrite.$executeRaw`
    UPDATE "ModelVersion"
    SET meta = ${asJsonbObjectSql(
      'meta'
    )} - 'needsReview' - 'declinedReason' - 'decliendAt' - 'declinedAt'
    WHERE id IN (${Prisma.join(gatedVersionIds)}) AND "modelId" = ${modelId}
  `;
  await writeGateMeta(modelId, {
    ...(previous ?? { scope: 'model', requestedAt: new Date().toISOString() }),
    state: 'passed',
    runId,
    versionIds: [...new Set([...(previous?.versionIds ?? []), ...gatedVersionIds])],
    passedVersionIds: [...new Set([...(previous?.passedVersionIds ?? []), ...gatedVersionIds])],
  });
}

/**
 * Ends a waiting run the resolver cannot finish (the publish was refused before or by the gate, or
 * the owner may no longer publish), so it leaves the queue. Only the run still waiting is touched.
 */
export async function closeWaitingGate(modelId: number, runId: string) {
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = jsonb_set(meta, '{prePublishGate,state}', '"refused"')
    WHERE id = ${modelId}
      AND meta->'prePublishGate'->>'state' = 'pending'
      AND meta->'prePublishGate'->>'runId' = ${runId}
  `;
}

const MAX_FAILED_ATTEMPTS = 12;

/**
 * Counts a resolver pass that errored; the run ends, refused, after MAX_FAILED_ATTEMPTS. A pass the
 * gate recorded before the publish failed goes back to waiting, or the run would leave the queue.
 */
export async function countFailedAttempt(modelId: number, runId: string) {
  const [row] = await dbWrite.$queryRaw<{ state: string }[]>`
    UPDATE "Model"
    SET meta = jsonb_set(
      jsonb_set(
        meta, '{prePublishGate,attempts}',
        to_jsonb(COALESCE((meta->'prePublishGate'->>'attempts')::int, 0) + 1)
      ),
      '{prePublishGate,state}',
      CASE WHEN COALESCE((meta->'prePublishGate'->>'attempts')::int, 0) + 1 >= ${MAX_FAILED_ATTEMPTS}
        THEN '"refused"'::jsonb ELSE '"pending"'::jsonb END
    )
    WHERE id = ${modelId}
      AND meta->'prePublishGate'->>'state' IN ('pending', 'passed')
      AND meta->'prePublishGate'->>'runId' = ${runId}
    RETURNING meta->'prePublishGate'->>'state' AS state
  `;
  if (row?.state === 'refused')
    await notifyOwnerOfResolverOutcome(modelId, runId, { outcome: 'unfinished' });
}

/** A held model waits for a moderator; one they declined since stays held, and says so. */
async function modelHoldState(modelId: number): Promise<'held' | 'declined' | null> {
  const model = await dbWrite.model.findUnique({ where: { id: modelId }, select: { meta: true } });
  const meta = model?.meta as { prePublishHold?: boolean } | null;
  if (meta?.prePublishHold !== true) return null;
  return isMetaDeclined(meta) ? 'declined' : 'held';
}

/**
 * Whether a moderator holds any of these versions, or the model itself. Read from marks only the
 * hold and a moderator's release write (the version's needs-review flag, the model's hold flag),
 * never from the gate's latest run, which any later run replaces.
 */
async function isHeldForModerator(modelId: number, gatedVersionIds: number[]) {
  const heldVersions = await dbWrite.modelVersion.count({
    where: { id: { in: gatedVersionIds }, modelId, ...heldVersionWhere },
  });
  return heldVersions > 0;
}
