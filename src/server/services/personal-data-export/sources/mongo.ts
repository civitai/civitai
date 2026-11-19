import { CREDENTIAL_NAME_RE, CLASSIFIER_NAME_RE } from '../column-policy';
import { jsonLinesFile, type ExportWriter, type ManifestFile } from '../output';

/**
 * Stored generation workflow documents, read from the database directly. This module never calls
 * the orchestrator: fetching a workflow through its API can activate it and refund Buzz (an import
 * guard test pins that).
 */

export const MONGO_DATABASE = 'prod';
export const MONGO_COLLECTION = 'workflows';
export const MONGO_BATCH_SIZE = 200;
export const MONGO_MAX_TIME_MS = 60_000;
/** Documents read at most; past it the manifest says the file is partial. */
export const MONGO_DOC_CAP = 50_000;

export const WORKFLOWS_FILE = 'data/mongo/generation-workflows.jsonl';

/**
 * A workflow `_id` is `<userId>-<timestamp>-<suffix>`, so a user's workflows are the `_id` range
 * from `"<userId>-"` up to `"<userId>."` (`.` sorts right after `-`). An index range on `_id`,
 * never a query by any other field, which would scan the collection.
 */
export function workflowRange(userId: number) {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error(`Refusing to export for user id ${String(userId)}`);
  return { _id: { $gte: `${userId}-`, $lt: `${userId}.` } };
}

export type WorkflowCursor = AsyncIterable<Record<string, unknown>> & { close(): Promise<void> };

/** The subset of a driver collection the export uses. */
export type WorkflowCollection = {
  find(
    filter: ReturnType<typeof workflowRange>,
    options: {
      sort: { _id: 1 };
      hint: '_id_';
      batchSize: number;
      maxTimeMS: number;
      limit: number;
    }
  ): WorkflowCursor;
};

const BLOCKED_KEYS = ['blockedReason', 'blocked'] as const;

function isBlockedOutput(o: Record<string, unknown>) {
  return BLOCKED_KEYS.some((k) => o[k] !== undefined && o[k] !== null && o[k] !== false);
}

/**
 * A workflow document as written. Credential-looking and classifier-looking keys are dropped at any
 * depth, and any output marked blocked is left out entirely, URL and all.
 */
export function reduceWorkflow(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter((v) => !(v && typeof v === 'object' && isBlockedOutput(v as Record<string, unknown>)))
      .map(reduceWorkflow);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_NAME_RE.test(k) || CLASSIFIER_NAME_RE.test(k) || /callback/i.test(k)) continue;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      isBlockedOutput(v as Record<string, unknown>)
    )
      continue;
    out[k] = reduceWorkflow(v);
  }
  return out;
}

export async function exportWorkflows({
  userId,
  writer,
  collection,
}: {
  userId: number;
  writer: ExportWriter;
  collection: WorkflowCollection;
}): Promise<ManifestFile> {
  const entry: ManifestFile = {
    file: WORKFLOWS_FILE,
    source: 'mongo',
    rows: 0,
    description:
      'Your generation workflows: prompts, settings, resources, steps and dates. Outputs are listed as links and details, not files.',
    status: 'complete',
  };
  // One past the cap, so reaching it is distinguishable from having exactly that many.
  const cursor = collection.find(workflowRange(userId), {
    sort: { _id: 1 },
    hint: '_id_',
    batchSize: MONGO_BATCH_SIZE,
    maxTimeMS: MONGO_MAX_TIME_MS,
    limit: MONGO_DOC_CAP + 1,
  });
  const docs = async function* () {
    let n = 0;
    try {
      for await (const doc of cursor) {
        if (++n > MONGO_DOC_CAP) {
          entry.status = 'partial';
          break;
        }
        yield reduceWorkflow(doc);
      }
    } catch (e) {
      // The time limit: what was read stays, and the file says it is partial.
      if ((e as { codeName?: string })?.codeName !== 'MaxTimeMSExpired') throw e;
      entry.status = 'partial';
    } finally {
      await cursor.close();
    }
  };
  await writer.addFile(
    WORKFLOWS_FILE,
    jsonLinesFile(docs(), () => entry.rows++)
  );
  return entry;
}
