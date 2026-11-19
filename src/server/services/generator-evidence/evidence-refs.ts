export type EvidenceRole = 'input' | 'output';

/** One file a generation named, found in a workflow the server read itself or in a stored trigger. */
export type EvidenceRef =
  | {
      kind: 'blob';
      blobId: string;
      role: EvidenceRole;
      stepName?: string;
      /** The orchestrator's verdict on an output, when it withheld it. */
      blockedReason?: string;
      /** The orchestrator job that produced an output, as the workflow read reports it. */
      orchestratorJobId?: string;
    }
  | { kind: 'external'; role: EvidenceRole; stepName?: string; host: string; url: string };

export type EvidenceJob = {
  jobId: string;
  source: 'workflow' | 'trigger';
  workflowId?: string;
  restrictionId?: number;
  prompt?: string;
  negativePrompt?: string;
  resources?: string[];
  dateTime?: string;
  refs: EvidenceRef[];
};

const AIR_BLOB = /^urn:air:[^:]+:[^:]+:orchestrator:blob@([^\s?#]+)$/i;
// Keys are opaque, but a path segment or a urn version never carries these.
const BLOB_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MEDIA_PATH = /\.(jpe?g|png|webp|gif|avif|mp4|webm|mov)$/i;

const CIVITAI_HOST = /(^|\.)civitai\.com$/;
const BLOB_PATHS = ['/v2/consumer/blobs/', '/v1/consumer/blobs/'];
const RESERVED_SEGMENTS = new Set(['content', 'blocked', 'archive', 'upload', 'ingest']);

/**
 * The orchestrator blob key a step input or trigger names: an orchestrator AIR, or a consumer blob
 * URL on the orchestrator's origin or a civitai.com host. Only the key is used, and it is read from
 * our own orchestrator; the URL is never fetched.
 */
export function parseOrchestratorBlobKey(value: string, orchestratorOrigin: string) {
  const air = AIR_BLOB.exec(value.trim());
  if (air) return BLOB_KEY.test(air[1]) ? air[1] : null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.origin !== orchestratorOrigin && !CIVITAI_HOST.test(url.hostname)) return null;
  const path = url.pathname.toLowerCase();
  const prefix = BLOB_PATHS.find((p) => path.startsWith(p));
  if (!prefix) return null;
  const rest = url.pathname.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  let key: string;
  try {
    key = decodeURIComponent(rest);
  } catch {
    return null;
  }
  return BLOB_KEY.test(key) && !RESERVED_SEGMENTS.has(key.toLowerCase()) ? key : null;
}

function asHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** A source image named by URL or AIR: an orchestrator blob, or a file the orchestrator fetched from elsewhere. */
export function refForSource(
  value: string,
  role: EvidenceRole,
  stepName: string | undefined,
  orchestratorOrigin: string
): EvidenceRef | null {
  const blobId = parseOrchestratorBlobKey(value, orchestratorOrigin);
  if (blobId) return { kind: 'blob', blobId, role, stepName };
  const url = asHttpUrl(value);
  if (!url || url.origin === orchestratorOrigin || !MEDIA_PATH.test(url.pathname)) return null;
  return { kind: 'external', role, stepName, host: url.host, url: `${url.origin}${url.pathname}` };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function walk(value: unknown, visit: (node: unknown) => void, depth = 0) {
  if (depth > 12) return;
  visit(value);
  if (Array.isArray(value)) for (const item of value) walk(item, visit, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) walk(item, visit, depth + 1);
}

/** An output blob as the orchestrator reports it: an id, an availability verdict and its job. */
function asOutputBlob(node: unknown) {
  if (!isRecord(node) || typeof node.id !== 'string' || typeof node.available !== 'boolean')
    return null;
  if (!BLOB_KEY.test(node.id)) return null;
  return {
    blobId: node.id,
    blockedReason: typeof node.blockedReason === 'string' ? node.blockedReason : undefined,
    ...(typeof node.jobId === 'string' &&
      JOB_ID.test(node.jobId) && { orchestratorJobId: node.jobId }),
  };
}

const str = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function stepResources(input: Record<string, unknown>) {
  const resources = new Set<string>();
  const model = str(input.model);
  if (model) resources.add(model);
  for (const key of ['additionalNetworks', 'loras'])
    if (isRecord(input[key])) for (const air of Object.keys(input[key])) resources.add(air);
  if (Array.isArray(input.resources))
    for (const r of input.resources) {
      const air = str(r) ?? (isRecord(r) ? str(r.air) ?? str(r.id) : undefined);
      if (air) resources.add(air);
    }
  return [...resources];
}

/**
 * Every input and output file of a workflow, with its prompt. Inputs are the source URLs and AIRs in
 * each step's input; outputs are the blobs in each step's output, withheld ones included by id.
 */
export function collectWorkflowEvidence(workflow: unknown, orchestratorOrigin: string) {
  if (!isRecord(workflow) || typeof workflow.id !== 'string') return null;
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  const add = (ref: EvidenceRef | null) => {
    if (!ref) return;
    const key = ref.kind === 'blob' ? `blob:${ref.blobId}` : `external:${ref.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  let prompt: string | undefined;
  let negativePrompt: string | undefined;
  const resources = new Set<string>();

  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  // Outputs first: a later step's input that is an earlier step's output is that output, not an upload.
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const stepName = str(step.name);
    walk(step.output, (node) => {
      const blob = asOutputBlob(node);
      if (blob) add({ kind: 'blob', role: 'output', stepName, ...blob });
    });
  }
  for (const step of steps) {
    if (!isRecord(step) || !isRecord(step.input)) continue;
    const stepName = str(step.name);
    prompt ??= str(step.input.prompt);
    negativePrompt ??= str(step.input.negativePrompt);
    for (const r of stepResources(step.input)) resources.add(r);
    walk(step.input, (node) => {
      if (typeof node === 'string') add(refForSource(node, 'input', stepName, orchestratorOrigin));
    });
  }

  return {
    jobId: workflow.id,
    source: 'workflow',
    workflowId: workflow.id,
    prompt,
    negativePrompt,
    resources: resources.size ? [...resources] : undefined,
    dateTime: str(workflow.createdAt),
    refs,
  } satisfies EvidenceJob;
}

const WORKFLOW_ID = /^(\d{1,10})-(\d{14})\d{0,6}(?:-[a-z0-9]{1,32})?$/;

/** The submitter an orchestrator workflow id begins with; null when it is not a workflow id. */
export function workflowOwnerId(workflowId: string) {
  const match = WORKFLOW_ID.exec(workflowId);
  if (!match) return null;
  const ownerId = Number(match[1]);
  return Number.isInteger(ownerId) && ownerId > 0 && ownerId <= 2_147_483_647 ? ownerId : null;
}
