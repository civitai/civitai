import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { recordUnderSavepoint, type LabelStoreTx } from '~/server/services/label-store.service';
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

type RawTx = LabelStoreTx;

// timeout: the write, the read-back and up to two labels (an appeal rules both flags), plus a wait on the model's row lock.
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
  verdict: TextScanVerdict;
  reason?: string;
  note?: string;
};

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

/** An entity's scan subject as its profile loads it now, or undefined when it cannot be read. */
export async function loadTextScanSubject(entityType: string, entityId: number) {
  return (await getTextScanProfile(entityType)?.load([entityId]))?.get(entityId);
}

/** Runs a flag writer and records its ruling as a label in the same transaction. `wrote` says whether the write changed anything; a write that landed on nothing records nothing. A failed label never fails the write (see `guarded`). */
export async function writeTextScanRuling<T>(
  ruling: TextScanModelRuling,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  wrote: (result: T) => boolean
): Promise<T> {
  // Read before the transaction, so the decision's row lock is not held across the profile load.
  const text = await loadTextScanSubject('Model', ruling.modelId).then(
    (subject) => (subject ? composeUserText(subject) : null),
    () => null
  );
  return dbWrite.$transaction(async (tx) => {
    const result = await write(tx);
    if (wrote(result)) await recordTextScanModelRuling(tx, ruling, text);
    return result;
  }, RULING_TRANSACTION);
}

/** Records one label per ruled label that carries a text-scan verdict; a hash-only flag or ruling stub records nothing. Must be the transaction's last step; see `guarded`. */
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

/** Records a moderator's ruling as a human label inside the caller's transaction. Must be the last step; see `guarded`. True when a label was added; a retry of the same ruling by the same moderator on the same text adds nothing. */
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

/** See `recordUnderSavepoint`: last step of the transaction only. */
function guarded(tx: RawTx, modelId: number, record: () => Promise<boolean>) {
  return recordUnderSavepoint(tx, record, (error) => logNotRecorded(modelId, error));
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
