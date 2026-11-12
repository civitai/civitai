import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { Tracker } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isAccountMuted } from '~/server/services/account-standing.service';
import {
  closeWaitingGate,
  countFailedAttempt,
} from '~/server/services/pre-publish-gate/gate.service';
import type { PrePublishGateMeta } from '~/server/services/pre-publish-gate/types';
import type { SessionUser } from '~/types/session';
import { createJob } from './job';

const REFUSALS: TRPCError['code'][] = ['BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'];
const BATCH = 100;
const MAX_VERSIONS = 50;

type Waiting = { id: number; userId: number; gate: PrePublishGateMeta };

/**
 * Models whose owner asked to publish and whose pre-publish checks were still running, oldest ask
 * first. Found through the gate's own log, which holds only gated models, so the Model table is
 * read by id and never scanned.
 */
export const waitingGatesSql = (limit: number) => Prisma.sql`
  SELECT m.id, m."userId", m.meta->'prePublishGate' AS gate
  FROM "Model" m
  WHERE m.id IN (
      SELECT DISTINCT "modelId" FROM "ModelPublishCheck"
      WHERE "check" = 'gate' AND (outcome = 'pending' OR detail->>'scheduled' = 'true')
    )
    AND m.meta->'prePublishGate'->>'state' = 'pending'
    AND m."deletedAt" IS NULL
    -- A scheduled publish is checked again, and goes out, when its time comes.
    -- Epoch ms, not the ISO date: an owner's date may be a year Postgres cannot cast, which would
    -- fail the whole query. A non-numeric value is skipped, never cast.
    AND (
      m.meta->'prePublishGate'->'publishedAtMs' IS NULL
      OR (
        jsonb_typeof(m.meta->'prePublishGate'->'publishedAtMs') = 'number'
        AND (m.meta->'prePublishGate'->>'publishedAtMs')::numeric
          <= EXTRACT(EPOCH FROM NOW()) * 1000
      )
    )
  ORDER BY m.meta->'prePublishGate'->>'requestedAt', m.id
  LIMIT ${limit}
`;

export async function getWaitingGates(limit = BATCH) {
  return dbWrite.$queryRaw<Waiting[]>(waitingGatesSql(limit));
}

/** Whether the owner could still publish now: what `guardedProcedure` checks on the original ask. */
async function ownerMayPublish(userId: number) {
  const owner = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, deletedAt: true, muted: true },
  });
  if (!owner || owner.bannedAt || owner.deletedAt) return false;
  return !(await isAccountMuted(userId, !!owner.muted));
}

/**
 * Asks again, as the owner and the way they asked, so the gate re-checks and a pass publishes with
 * every side effect of an ordinary publish. The run id carries over, so the log keeps one run.
 * Only this model's own versions are asked for: the handlers are called without the router's
 * ownership check.
 */
export async function resolveWaitingGate({ id, userId, gate }: Waiting, track: Tracker) {
  if (!(await ownerMayPublish(userId))) return closeWaitingGate(id, gate.runId);
  const versionIds = (
    await dbWrite.modelVersion.findMany({
      where: { id: { in: (gate.versionIds ?? []).slice(0, MAX_VERSIONS) }, modelId: id },
      select: { id: true },
    })
  ).map((v) => v.id);
  // A version publish names its version; a model publish may list none, meaning all, as asked.
  if (gate.scope === 'version' && !versionIds.length) return closeWaitingGate(id, gate.runId);
  if (gate.scope === 'model' && gate.versionIds?.length && !versionIds.length)
    return closeWaitingGate(id, gate.runId);

  const user = { id: userId, isModerator: false } as SessionUser;
  const ctx = { user, track, prePublishGateRunId: gate.runId };
  const publishedAt = gate.publishedAt ? new Date(gate.publishedAt) : undefined;
  if (gate.scope === 'version') {
    const { publishModelVersionHandler } = await import(
      '~/server/controllers/model-version.controller'
    );
    for (const versionId of versionIds)
      await publishModelVersionHandler({ input: { id: versionId, publishedAt }, ctx });
    return;
  }
  const { publishModelHandler, publishPrivateModelHandler } = await import(
    '~/server/controllers/model.controller'
  );
  if (gate.scope === 'private')
    await publishPrivateModelHandler({
      input: { modelId: id, publishVersions: gate.publishVersions ?? true },
      ctx,
    });
  else
    await publishModelHandler({
      input: { id, versionIds: versionIds.length ? versionIds : undefined, publishedAt },
      ctx,
    });
}

export const resolvePrePublishGates = createJob(
  'resolve-pre-publish-gates',
  '*/5 * * * *',
  async (jobCtx) => {
    const track = new Tracker();
    const waiting = await getWaitingGates();
    let failed = 0;
    for (const row of waiting) {
      jobCtx.checkIfCanceled();
      try {
        await resolveWaitingGate(row, track);
      } catch (error) {
        // A refusal, by the gate or by the publish itself, ends the run; anything else is retried.
        if (error instanceof TRPCError && REFUSALS.includes(error.code)) {
          await closeWaitingGate(row.id, row.gate.runId);
          continue;
        }
        failed++;
        // Retried, but not for ever: a run that keeps failing must not hold the front of the queue.
        await countFailedAttempt(row.id, row.gate.runId);
        logToAxiom({
          name: 'pre-publish-gate',
          type: 'error',
          message: 'resolve failed',
          modelId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => null);
      }
    }
    return { waiting: waiting.length, failed };
  }
);
