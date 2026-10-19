import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  readTextScanFlags,
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
// `text-scan/profiles` resolves to the registry file; only the barrel registers the profiles.
import '~/server/services/text-scan/profiles/index';
import { composeUserText } from '~/server/services/text-scan/segment';
import type { PromptIds } from '~/server/services/text-scan/types';

export const TEXT_SCAN_LABEL_FAMILY = 'text_scan';

export const textScanModelQuestion = (label: TextScanFlagLabel) => `text_scan.model.${label}`;

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

// maxWait: Prisma's default pool_timeout, what a ruling written as a bare statement waited for a
// connection. timeout: the ruling's write plus the read-back and at most two labels (an appeal rules
// both flags at once), each capped at 3s (`guarded`), with room for the write to wait on the model's row lock.
const RULING_TRANSACTION = { maxWait: 10_000, timeout: 15_000 };

type TextScanVerdict = { workflowId: string; promptIds?: PromptIds | null; reason?: string | null };

export type TextScanModelLabelInput = {
  modelId: number;
  label: TextScanFlagLabel;
  /** `flag`: the flag stands (kept, upheld). `clear`: it was lifted, granted or dismissed. */
  value: 'flag' | 'clear';
  /** `appeal` for a ruling on the owner's appeal: the store keeps it out of consensus. */
  labellerKind: 'moderator' | 'appeal';
  moderatorId: number;
  /** The scanned text the ruling covers (the flag's or held detection's `textHash`). */
  textHash: string;
  /** The model's composed text now; stored only while it still hashes to `textHash`. */
  text: string | null;
  /** The scan verdict the moderator ruled on. */
  verdict: TextScanVerdict;
  reason?: string;
  note?: string;
};

/** A ruling as the flag writers stamp it on `Model.meta.textScanFlags`. */
export type TextScanModelRuling = {
  modelId: number;
  labels: TextScanFlagLabel[];
  decision: 'appealGranted' | 'appealUpheld';
  via: 'appeal' | 'moderator';
  moderatorId: number;
  reason?: string;
  note?: string;
  /** A held detection being ruled on: its verdict, which the write removes from the flag. */
  heldDetection?: TextScanVerdict & { textHash: string };
};

/** The model's text as the scan composes it, or null when it cannot be read. */
export async function loadTextScanModelText(modelId: number) {
  const subject = (await getTextScanProfile('Model')?.load([modelId]))?.get(modelId);
  return subject ? composeUserText(subject) : null;
}

/**
 * Runs a flag writer and records its ruling as a label in the same transaction, so the label
 * commits and rolls back with the decision. `wrote` says whether the write changed anything; a
 * write that landed on nothing records nothing. Recording never fails the write.
 */
export async function writeTextScanRuling<T>(
  ruling: TextScanModelRuling,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  wrote: (result: T) => boolean
): Promise<T> {
  // Read before the transaction, so the decision's row lock is not held across the profile load.
  const text = await loadTextScanModelText(ruling.modelId).catch(() => null);
  return dbWrite.$transaction(async (tx) => {
    const result = await write(tx);
    // Last, as the label statement timeout it sets lasts to the end of the transaction.
    if (wrote(result)) await recordTextScanModelRuling(tx, ruling, text);
    return result;
  }, RULING_TRANSACTION);
}

/**
 * Records one label per ruled label that carries a text-scan verdict; a flag with no verdict (a
 * hash-only flag, a ruling stub) records nothing. Reads the ruling back from the row the caller just
 * wrote, for the hash it stamped. Must be the transaction's last step; see `guarded`.
 */
export function recordTextScanModelRuling(
  tx: RawTx,
  ruling: TextScanModelRuling,
  text: string | null
) {
  return guarded(tx, ruling.modelId, async () => {
    const [row] = await tx.$queryRaw<{ flags: unknown }[]>`
      SELECT m.meta->${TEXT_SCAN_FLAGS_KEY}::text AS flags FROM "Model" m WHERE m.id = ${ruling.modelId}::int
    `;
    const flags = readTextScanFlags({ [TEXT_SCAN_FLAGS_KEY]: row?.flags });
    let recorded = false;
    for (const label of ruling.labels) {
      const entry = flags[label];
      const verdict = ruling.heldDetection ?? entry;
      const textHash = ruling.heldDetection?.textHash ?? entry?.[ruling.decision]?.textHash;
      const workflowId = verdict?.workflowId;
      if (!workflowId || !textHash) continue;
      const added = await recordLabel(tx, {
        modelId: ruling.modelId,
        label,
        value: ruling.decision === 'appealUpheld' ? 'flag' : 'clear',
        labellerKind: ruling.via,
        moderatorId: ruling.moderatorId,
        textHash,
        text,
        verdict: {
          workflowId,
          promptIds: verdict?.promptIds,
          reason: verdict?.reason,
        },
        reason: ruling.reason,
        note: ruling.note,
      });
      recorded ||= added;
    }
    return recorded;
  });
}

/**
 * Records a moderator's ruling on a text-scan model flag as a human label, inside the caller's
 * decision transaction so the label commits and rolls back with it. Must be the transaction's last
 * step; see `guarded`. True when a label was added; a retry of the same ruling by the same
 * moderator on the same text adds nothing.
 */
export function recordTextScanModelLabel(tx: RawTx, input: TextScanModelLabelInput) {
  return guarded(tx, input.modelId, () => recordLabel(tx, input));
}

async function recordLabel(tx: RawTx, input: TextScanModelLabelInput) {
  const { modelId, label, value, labellerKind, moderatorId, textHash, text, verdict } = input;
  const [row] = await tx.$queryRaw<{ id: bigint | number | null }[]>`
    SELECT label_store.record_label(
      p_subject_type => 'model_text',
      p_subject_id => ${String(modelId)}::text,
      p_content_hash => ${textHash}::text,
      p_family => ${TEXT_SCAN_LABEL_FAMILY}::text,
      p_question => ${textScanModelQuestion(label)}::text,
      p_value => ${value}::text,
      p_labeller_kind => ${labellerKind}::text,
      p_labeller_user_id => ${moderatorId}::int,
      p_source_ref => concat_ws(':', 'TextScanRuling', 'Model', ${modelId}::int, ${label}::text,
        ${labellerKind}::text, ${value}::text, ${textHash}::text,
        label_store.person_hash('labeller', ${moderatorId}::int)),
      p_labelled_at => now(),
      p_reason => ${input.reason ?? null}::text,
      p_reason_note => ${input.note ?? null}::text,
      p_snapshot => jsonb_strip_nulls(jsonb_build_object(
        'text', CASE WHEN label_store.text_hash(${text}::text) = ${textHash}::text
          THEN ${text}::text END,
        'textHash', ${textHash}::text,
        'workflowId', ${verdict.workflowId}::text,
        'promptIds', ${verdict.promptIds ? JSON.stringify(verdict.promptIds) : null}::jsonb,
        'verdictReason', ${verdict.reason ?? null}::text
      )),
      p_owner_user_id => m."userId"
    ) AS id
    FROM "Model" m
    WHERE m.id = ${modelId}::int
  `;
  return row?.id != null;
}

/**
 * Runs the label work under a savepoint with a statement timeout, so a store that refuses, is
 * missing or is slow rolls back to the savepoint and the decision still commits: the store logs
 * its own refusals to `record_failure`, the rest is logged here. The timeout is `SET LOCAL` and
 * outlives a released savepoint, hence last step only. Throws only when the savepoint itself fails,
 * since the transaction is then aborted and its COMMIT would silently drop the decision.
 */
async function guarded(tx: RawTx, modelId: number, record: () => Promise<boolean>) {
  await tx.$executeRaw`SAVEPOINT text_scan_label`;
  try {
    // Above the store's own 2s lock_timeout, so one lock wait completes; a label cut off here rolls
    // back to the savepoint.
    await tx.$executeRaw`SET LOCAL statement_timeout = '3s'`;
    const recorded = await record();
    await tx.$executeRaw`RELEASE SAVEPOINT text_scan_label`;
    return recorded;
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT text_scan_label`;
    logNotRecorded(modelId, error);
    return false;
  }
}

function logNotRecorded(modelId: number, error: unknown) {
  logToAxiom({
    type: 'error',
    name: 'text-scan',
    message: 'moderator ruling not recorded as a label',
    entityType: 'Model',
    entityId: modelId,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => null);
}
