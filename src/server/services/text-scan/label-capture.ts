import type { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';
import type { TextScanFlagLabel } from '~/server/services/text-scan/flag-snapshot';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
// `text-scan/profiles` resolves to the registry file; only the barrel registers the profiles.
import '~/server/services/text-scan/profiles/index';
import { composeUserText } from '~/server/services/text-scan/segment';
import type { PromptIds } from '~/server/services/text-scan/types';

export const TEXT_SCAN_LABEL_FAMILY = 'text_scan';

export const textScanModelQuestion = (label: TextScanFlagLabel) => `text_scan.model.${label}`;

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

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
  verdict: { workflowId: string; promptIds?: PromptIds | null; reason?: string | null };
  reason?: string;
  note?: string;
};

/** The model's text as the scan composes it, or null when it cannot be read. */
export async function loadTextScanModelText(modelId: number) {
  const subject = (await getTextScanProfile('Model')?.load([modelId]))?.get(modelId);
  return subject ? composeUserText(subject) : null;
}

/**
 * Records a moderator's ruling on a text-scan model flag as a human label, inside the caller's
 * decision transaction so the label commits and rolls back with it. Never throws and never aborts
 * that transaction: the store logs its own refusals to `record_failure`, and anything else (the
 * store missing, a bad parameter) is rolled back to a savepoint. True when a label was added; a
 * retry of the same ruling by the same moderator on the same text adds nothing.
 */
export async function recordTextScanModelLabel(
  tx: RawTx,
  input: TextScanModelLabelInput
): Promise<boolean> {
  const { modelId, label, value, labellerKind, moderatorId, textHash, text, verdict } = input;
  try {
    await tx.$executeRaw`SAVEPOINT text_scan_label`;
  } catch (error) {
    logNotRecorded(input, error);
    return false;
  }
  try {
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
    await tx.$executeRaw`RELEASE SAVEPOINT text_scan_label`;
    return row?.id != null;
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT text_scan_label`.catch(() => null);
    logNotRecorded(input, error);
    return false;
  }
}

function logNotRecorded(input: TextScanModelLabelInput, error: unknown) {
  logToAxiom({
    type: 'error',
    name: 'text-scan',
    message: 'moderator ruling not recorded as a label',
    entityType: 'Model',
    entityId: input.modelId,
    label: input.label,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => null);
}
