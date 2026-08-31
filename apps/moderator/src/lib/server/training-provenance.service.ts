import { dbRead } from '$lib/server/db';
import { getClickhouse } from '$lib/server/clickhouse';
import { clickhouseDate } from '$lib/server/clickhouse-date';
import { submitSecond } from '$lib/server/training-orchestration.service';
import { TRAINING_DATA_FILE_TYPE } from '$lib/server/training-moderation.service';
import { utcMs } from '$lib/format';

/**
 * Who PAID for the run a model came from, and whether that is who uploaded it.
 *
 * The abuse this exists for: train on data that breaks the ToS, keep the model in draft on the main
 * account, re-upload it from a burner with no IP link and tamer previews. The accounts look unrelated
 * because they are — the only thing tying them together is the training run, and finding it took a
 * moderator reading a workflow id out of metadata by hand and asking someone else to resolve it.
 *
 * 🔴 **This catches carelessness, not evasion.** It joins on the workflow id left in the model's own
 * training file. Strip that, or upload a bare safetensors with no training file, and there is nothing
 * here to match on — a clean result means "nothing to link", never "nothing to find".
 */

/** A workflow id reaches ClickHouse by string interpolation, so it is constrained rather than escaped.
 *  Every real one is an orchestrator-issued `<prefix>-<timestamp>` in this alphabet. */
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** How far around the workflow's own submit second to look for its charge.
 *
 *  The window is the whole cost of this query — `buzzTransactions` is `ORDER BY createdAt` with no
 *  index on workflow, so an unbounded lookup scans the full history (measured elsewhere in this
 *  service: 19.1s over 912 days against 0.7s over 7). The id carries the submit instant, so the bound
 *  is free. Two minutes is slack for the charge landing either side of the stamp, not an estimate. */
const WINDOW_MS = 120_000;

export type TrainingProvenance = {
  workflowId: string;
  /** The account charged for the run. Null when no charge is in the window — see `reachable`. */
  payerUserId: number | null;
  payerUsername: string | null;
  /** Who owns the model today. */
  uploaderUserId: number;
  uploaderUsername: string | null;
  /** The thing worth looking at: the run was paid for by an account that does not own the model. */
  mismatch: boolean;
  chargedAt: string | null;
  /** False when ClickHouse could not be asked. Distinguishes "no link" from "did not look" — a
   *  moderator must not read an outage as a clean bill. */
  reachable: boolean;
};

const ymdhms = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * The inverse of `getTrainingOrchestration`'s charge query: that one asks "which runs did this account
 * pay for", this asks "which account paid for this run". Same table, same column, filter swapped.
 */
async function getPayerAccount(
  workflowId: string
): Promise<{ userId: number; chargedAt: string } | null> {
  const second = submitSecond({ id: '', date: '', workflowId });
  if (!second) return null;
  const ms = utcMs(second);
  if (Number.isNaN(ms)) return null;

  const rows = await getClickhouse().$query<{ payer: number; date: string }>(`
    SELECT fromAccountId AS payer, toString(date) AS date
    FROM buzzTransactions
    WHERE type = 'training'
      AND JSONExtractString(details, 'workflowId') = '${workflowId}'
      AND date >= '${ymdhms(ms - WINDOW_MS)}'
      AND date <= '${ymdhms(ms + WINDOW_MS)}'
    LIMIT 1
  `);

  const row = rows[0];
  return row
    ? { userId: Number(row.payer), chargedAt: clickhouseDate(row.date.slice(0, 19)) }
    : null;
}

/**
 * Provenance for one model version. Returns null when the version has no training run recorded — the
 * common case for an ordinary upload, and not something to render an empty panel for.
 */
export async function getTrainingProvenance(versionId: number): Promise<TrainingProvenance | null> {
  const version = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .leftJoin('User as u', 'u.id', 'm.userId')
    .select(['m.userId as uploaderUserId', 'u.username as uploaderUsername'])
    .where('mv.id', '=', versionId)
    .executeTakeFirst();
  if (!version) return null;

  const file = await dbRead
    .selectFrom('ModelFile')
    .select(['metadata'])
    .where('modelVersionId', '=', versionId)
    .where('type', '=', TRAINING_DATA_FILE_TYPE)
    .execute();

  const workflowId = file
    .map((f) => f.metadata as { trainingResults?: { workflowId?: string } } | null)
    .map((m) => m?.trainingResults?.workflowId)
    .find((id): id is string => !!id && WORKFLOW_ID.test(id));
  if (!workflowId) return null;

  const base = {
    workflowId,
    uploaderUserId: version.uploaderUserId,
    uploaderUsername: version.uploaderUsername,
  };

  let payer: { userId: number; chargedAt: string } | null = null;
  try {
    payer = await getPayerAccount(workflowId);
  } catch {
    // Reported as unreachable rather than as "no payer" — see `reachable`.
    return {
      ...base,
      payerUserId: null,
      payerUsername: null,
      mismatch: false,
      chargedAt: null,
      reachable: false,
    };
  }

  if (!payer)
    return {
      ...base,
      payerUserId: null,
      payerUsername: null,
      mismatch: false,
      chargedAt: null,
      reachable: true,
    };

  const payerUser = await dbRead
    .selectFrom('User')
    .select(['username'])
    .where('id', '=', payer.userId)
    .executeTakeFirst();

  return {
    ...base,
    payerUserId: payer.userId,
    payerUsername: payerUser?.username ?? null,
    mismatch: payer.userId !== version.uploaderUserId,
    chargedAt: payer.chargedAt,
    reachable: true,
  };
}
