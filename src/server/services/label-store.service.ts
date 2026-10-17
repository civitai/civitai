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

/** One round trip; each item is recorded or refused on its own. Results are in input order. */
export async function submitPredictions(items: PredictionSubmission[]): Promise<PredictionResult[]> {
  const rows = await dbWrite.$queryRaw<
    { ord: number; id: bigint | null; status: PredictionResult['status']; error: string | null }[]
  >`SELECT * FROM label_store.submit_predictions(${JSON.stringify(items)}::jsonb) ORDER BY "ord"`;
  return rows.map((row) => ({
    sourceRef: items[row.ord - 1].sourceRef,
    status: row.status,
    ...(row.id !== null ? { id: Number(row.id) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  }));
}
