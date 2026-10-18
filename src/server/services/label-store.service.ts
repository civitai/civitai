import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';

/** The fields of `label_store.submit_prediction`, camelCased; see docs/features/label-store.md. */
export type PredictionSubmission = {
  subjectType: string;
  subjectId: string;
  contentHash: string;
  question: string;
  questionVersion?: number;
  value: string;
  modelRef: string;
  sourceRef: string;
  predictedAt?: string;
  confidence?: number;
  scores?: Record<string, number>;
  versions?: Record<string, unknown>;
  inputHash?: string;
  detail?: Record<string, unknown>;
};

export type PredictionResult = {
  sourceRef: string;
  status: 'recorded' | 'duplicate' | 'rejected';
  id?: number;
  error?: string;
};

// Each item is a subtransaction; a transaction holding more than 64 slows every snapshot on the primary
// and its replicas.
const STATEMENT_ITEMS = 50;

/** Each item is recorded or refused on its own. Results are in input order. */
export async function submitPredictions(
  items: PredictionSubmission[]
): Promise<PredictionResult[]> {
  const results: PredictionResult[] = [];
  for (const part of chunk(items, STATEMENT_ITEMS)) {
    const rows = await dbWrite.$queryRaw<
      { ord: number; id: bigint | null; status: PredictionResult['status']; error: string | null }[]
    >`SELECT * FROM label_store.submit_predictions(${JSON.stringify(part)}::jsonb) ORDER BY "ord"`;
    for (const row of rows)
      results.push({
        sourceRef: part[row.ord - 1].sourceRef,
        status: row.status,
        ...(row.id !== null ? { id: Number(row.id) } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
      });
  }
  return results;
}
