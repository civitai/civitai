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

const BLOCKED_KEYS = ['blockedReason', 'blocked', 'BlockedReason', 'Blocked'] as const;

function isBlockedOutput(o: Record<string, unknown>) {
  return BLOCKED_KEYS.some((k) => o[k] !== undefined && o[k] !== null && o[k] !== false);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/**
 * Keys dropped inside a subtree the allowlist keeps whole (the user's own request settings), as a
 * second guard behind the allowlist. Case-insensitive, because stored documents use PascalCase.
 */
const NESTED_DENY_RE =
  /(callback|scan|hash|blobkey|trace|moderat|safety|classif|score|label|verdict|^user$|^messages$|responseformat|chattemplate)/i;

/**
 * Workflows the site runs on its own account of a user (automated checks), not generations the user
 * asked for: never written. The step type check is a second guard for a check whose purpose is unset.
 */
const SYSTEM_PURPOSE_RE = /(scan|moderat|audit|review|classif|check)/i;
const SYSTEM_STEP_TYPES = new Set(['ChatCompletionStep']);

export function isSystemWorkflow(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  const purpose = isObject(doc.Metadata) ? doc.Metadata.purpose : undefined;
  if (typeof purpose === 'string' && SYSTEM_PURPOSE_RE.test(purpose)) return true;
  const steps = Array.isArray(doc.Steps) ? doc.Steps : [];
  return steps.some(
    (s) => isObject(s) && (SYSTEM_STEP_TYPES.has(String(s._t)) || /scan/i.test(String(s.Name)))
  );
}

/**
 * Which keys of a stored workflow document are written. `leaf`: a plain value (or a list of them),
 * never an object. `tree`: the user's own settings, kept whole except for credential-, classifier-
 * and `NESTED_DENY_RE` keys. An object: only the keys it names. Every other key is left out, so a
 * field the orchestrator adds later stays out of the archive until it is listed here.
 */
type Shape = 'leaf' | 'tree' | { readonly [key: string]: Shape };

const PAYMENT_TIPS: Shape = { Civitai: 'leaf', Creators: 'leaf' };

/** An output file: its link and what it is, never its internal ids or storage tier. */
const MEDIA: Shape = {
  _id: 'leaf',
  Url: 'leaf',
  UrlExpiresAt: 'leaf',
  PreviewUrl: 'leaf',
  PreviewUrlExpiresAt: 'leaf',
  Available: 'leaf',
  Width: 'leaf',
  Height: 'leaf',
  Duration: 'leaf',
  NSFWLevel: 'leaf',
};

const STEP: Shape = {
  _t: 'leaf',
  Name: 'leaf',
  Status: 'leaf',
  Priority: 'leaf',
  StartedAt: 'leaf',
  CompletedAt: 'leaf',
  Cost: { Base: 'leaf', Factors: 'tree', Fixed: 'tree', Fees: 'tree', Tips: PAYMENT_TIPS },
  Input: 'tree',
  Output: {
    Images: MEDIA,
    Video: MEDIA,
    Blob: MEDIA,
    Epochs: { EpochNumber: 'leaf', Model: MEDIA, Samples: MEDIA },
  },
  Jobs: { Status: 'leaf', StartedAt: 'leaf', CompletedAt: 'leaf', Cost: 'leaf' },
};

export const WORKFLOW_SHAPE: Shape = {
  _id: 'leaf',
  Status: 'leaf',
  CreatedAt: 'leaf',
  StartedAt: 'leaf',
  CompletedAt: 'leaf',
  DeletedAt: 'leaf',
  Tags: 'leaf',
  NSFWLevel: 'leaf',
  AllowMatureContent: 'leaf',
  Currencies: 'leaf',
  Tips: PAYMENT_TIPS,
  Transactions: { List: { AccountType: 'leaf', Amount: 'leaf', Type: 'leaf' } },
  Metadata: {
    params: 'tree',
    resources: 'tree',
    name: 'leaf',
    imageCount: 'leaf',
    modelId: 'leaf',
    modelVersionId: 'leaf',
    loraType: 'leaf',
    media: 'leaf',
    cardType: 'leaf',
    trigger: 'leaf',
    isPrivateGeneration: 'leaf',
  },
  Steps: STEP,
};

function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function keepTree(value: unknown): unknown {
  if (Array.isArray(value))
    return value.filter((v) => !(isObject(v) && isBlockedOutput(v))).map(keepTree);
  if (!isObject(value)) return plain(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (CREDENTIAL_NAME_RE.test(k) || CLASSIFIER_NAME_RE.test(k) || NESTED_DENY_RE.test(k))
      continue;
    if (isObject(v) && isBlockedOutput(v)) continue;
    out[k] = keepTree(v);
  }
  return out;
}

function reduceBy(value: unknown, shape: Shape): unknown {
  if (shape === 'tree') return keepTree(value);
  if (shape === 'leaf') {
    if (Array.isArray(value)) return value.filter((v) => !isObject(v)).map(plain);
    return isObject(value) ? undefined : plain(value);
  }
  if (Array.isArray(value))
    return value.filter((v) => isObject(v) && !isBlockedOutput(v)).map((v) => reduceBy(v, shape));
  if (!isObject(value)) return undefined;
  if (isBlockedOutput(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, child] of Object.entries(shape)) {
    if (!(k in value)) continue;
    const v = reduceBy(value[k], child);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * A workflow document as written: only the keys `WORKFLOW_SHAPE` lists, so system fields
 * (automated-check results, storage keys, trace ids, internal state) are left out, and any output
 * marked blocked is left out entirely, URL and all.
 */
export function reduceWorkflow(value: unknown): unknown {
  return reduceBy(value, WORKFLOW_SHAPE) ?? {};
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
        if (isSystemWorkflow(doc)) continue;
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
