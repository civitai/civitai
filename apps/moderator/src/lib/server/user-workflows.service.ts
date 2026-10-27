import { env } from '$env/dynamic/private';
import { logToAxiom } from './axiom';

/**
 * One account's generation history, read straight from the orchestrator.
 *
 * The main app's `orchestrator.queryUserGeneratedImages` reaches the same data by minting a token for
 * the TARGET user and calling the consumer API as them. That path is not available here — minting is a
 * main-app concern (api keys, sysRedis) and duplicating it would put a cross-user token mint in a
 * second codebase. The orchestrator's `/v1/manager/workflows` takes `UserId` directly and authenticates
 * with the service token this app already holds, so it asks the question without impersonating anyone.
 *
 * Shapes are read defensively: a step's output is `$type`-dependent (`images` for imageGen, `video` for
 * videoGen, `blobs` for customComfy, `blob` elsewhere) and the orchestrator adds step types without
 * asking us. An unrecognised one contributes no media rather than throwing.
 */

/**
 * Which submitter's workflows to read. The orchestrator holds everything an account touched under one
 * id, and only the tag separates the sources. `comfy` makes Comfy Cloud investigable: it submits under
 * the user's own id and never appears in the `gen` feed.
 *
 * `all` sends no tag at all. Work submitted straight to the orchestrator can carry no tags, so every
 * tagged view misses it — one account ran ~10k such jobs a day while the `gen` view showed two — and
 * the tag filter is also what made that account's query take a minute (84 ms unfiltered). Each row
 * says where it came from instead (see `workflowOrigin`).
 */
export const WORKFLOW_SOURCE_TAGS = {
  onsite: 'gen',
  comfy: 'civitai-comfy-nodes',
} as const;

export const WORKFLOW_SOURCES = ['all', 'onsite', 'comfy'] as const;
export type WorkflowSource = (typeof WORKFLOW_SOURCES)[number];

export const isWorkflowSource = (v: string | null | undefined): v is WorkflowSource =>
  (WORKFLOW_SOURCES as readonly string[]).includes(v ?? '');

export type WorkflowOrigin = 'onsite' | 'comfy' | 'untagged' | 'other';

/** Where a row came from, read from its own tags. */
export function workflowOrigin(tags: string[]): WorkflowOrigin {
  if (tags.includes(WORKFLOW_SOURCE_TAGS.onsite)) return 'onsite';
  if (tags.includes(WORKFLOW_SOURCE_TAGS.comfy)) return 'comfy';
  return tags.length === 0 ? 'untagged' : 'other';
}

// Tags every submitter adds; they name nothing about what the workflow was.
const GENERIC_TAGS = new Set(['civitai']);

/** For an `other` row, the tag that says what it was (`training`, `prompt-enhancement`, …). */
export const otherSourceTag = (tags: string[]): string | null =>
  tags.find((t) => !GENERIC_TAGS.has(t) && !t.includes(':')) ?? null;

export type GeneratedMedia = {
  id: string;
  url: string;
  type: 'image' | 'video';
  width: number | null;
  height: number | null;
  nsfwLevel: string | null;
};

export type GeneratedWorkflow = {
  id: string;
  createdAt: string | null;
  status: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  /** The generation form that produced it (`txt2img`, `img2vid:ref2vid`, …), and its model family. */
  workflow: string | null;
  ecosystem: string | null;
  origin: WorkflowOrigin;
  /** Set for `other` rows only. */
  sourceTag: string | null;
  /** A generation that recorded none of prompt, form or model family. Not said of Comfy Cloud, which
   *  never sends them, nor of `other` workflows, whose params live elsewhere. */
  paramsMissing: boolean;
  media: GeneratedMedia[];
  /** Outputs the orchestrator will not serve — expired, or withheld. Counted so an empty grid is not
   *  read as "they generated nothing". */
  unavailable: number;
};

export type GeneratedWorkflowPage = {
  items: GeneratedWorkflow[];
  nextCursor: string | null;
};

type Blobish = {
  id?: unknown;
  url?: unknown;
  available?: unknown;
  width?: unknown;
  height?: unknown;
  nsfwLevel?: unknown;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'];

/**
 * customComfy names its outputs only by filename — the step declares no media type, and a comfy graph
 * saves whatever its nodes were wired to save. The extension is the only signal there is; an
 * unrecognised one renders as an image, which shows a broken tile rather than dropping the evidence.
 */
function mediaTypeFromName(name: string): 'image' | 'video' {
  const path = name.split('?')[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext)) ? 'video' : 'image';
}

function readBlob(
  raw: unknown,
  type: 'image' | 'video' | 'byName'
): GeneratedMedia | 'unavailable' | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Blobish;
  const url = str(b.url);
  // `available: false` still carries a URL, and it 404s. Counted, not rendered.
  if (!url || b.available === false) return 'unavailable';
  const id = str(b.id) ?? url;
  return {
    id,
    url,
    type: type === 'byName' ? mediaTypeFromName(id) : type,
    width: int(b.width),
    height: int(b.height),
    nsfwLevel: str(b.nsfwLevel),
  };
}

function readStepMedia(step: unknown): { media: GeneratedMedia[]; unavailable: number } {
  const media: GeneratedMedia[] = [];
  let unavailable = 0;
  const output = (step as { output?: unknown } | null)?.output;
  if (!output || typeof output !== 'object') return { media, unavailable };

  const o = output as { images?: unknown; video?: unknown; blob?: unknown; blobs?: unknown };
  const candidates: [unknown, 'image' | 'video' | 'byName'][] = [
    ...(Array.isArray(o.images) ? o.images.map((i): [unknown, 'image'] => [i, 'image']) : []),
    [o.video, 'video'],
    [o.blob, 'image'],
    // customComfy. `tempBlobs` sits beside this one and is deliberately skipped: it holds the graph's
    // intermediate artifacts, not what the user set out to make.
    ...(Array.isArray(o.blobs) ? o.blobs.map((b): [unknown, 'byName'] => [b, 'byName']) : []),
  ];

  for (const [raw, type] of candidates) {
    const read = readBlob(raw, type);
    if (read === 'unavailable') unavailable += 1;
    else if (read) media.push(read);
  }
  return { media, unavailable };
}

function readWorkflow(raw: unknown): GeneratedWorkflow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as {
    id?: unknown;
    createdAt?: unknown;
    status?: unknown;
    metadata?: { params?: Record<string, unknown> };
    steps?: unknown;
    tags?: unknown;
  };
  const id = str(w.id);
  if (!id) return null;

  // Comfy Cloud sends `metadata: {}`, so every field read from it is null for those rows — the prompt
  // exists only inside the raw node graph at `steps[].input.workflow`. The media carries them instead.
  const params = w.metadata?.params ?? {};
  const tags = Array.isArray(w.tags)
    ? w.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const origin = workflowOrigin(tags);
  const steps = Array.isArray(w.steps) ? w.steps : [];
  const media: GeneratedMedia[] = [];
  let unavailable = 0;
  for (const step of steps) {
    const read = readStepMedia(step);
    media.push(...read.media);
    unavailable += read.unavailable;
  }

  return {
    id,
    createdAt: str(w.createdAt),
    status: str(w.status),
    prompt: str(params.prompt),
    negativePrompt: str(params.negativePrompt),
    workflow: str(params.workflow),
    ecosystem: str(params.ecosystem),
    origin,
    sourceTag: origin === 'other' ? otherSourceTag(tags) : null,
    paramsMissing:
      (origin === 'onsite' || origin === 'untagged') &&
      !params.prompt &&
      !params.workflow &&
      !params.ecosystem,
    media,
    unavailable,
  };
}

// Cloudflare cuts a request at 100 s, so this cannot go much higher. One heavy account measured 63-70 s
// for this call (2026-10-27); the slow-call log below shows whether others are close.
export const ORCHESTRATOR_TIMEOUT_MS = 90_000;
const SLOW_CALL_MS = 30_000;

export async function getUserGeneratedWorkflows(
  userId: number,
  options: { take?: number; cursor?: string | null; source?: WorkflowSource } = {}
): Promise<GeneratedWorkflowPage> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) throw new Error('Orchestrator is not configured.');

  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const query = new URLSearchParams({
    UserId: String(userId),
    Take: String(Math.min(Math.max(options.take ?? 20, 1), 100)),
    ExcludeFailed: 'true',
  });
  const source = options.source ?? 'all';
  if (source !== 'all') query.set('Tags', WORKFLOW_SOURCE_TAGS[source]);
  if (options.cursor) query.set('Cursor', options.cursor);

  const started = Date.now();
  let outcome = 'error';
  let body: { items?: unknown; next?: unknown };
  try {
    const res = await fetch(`${base}/v1/manager/workflows?${query}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`The orchestrator refused the query (${res.status}).`);
    body = (await res.json()) as typeof body;
    outcome = 'ok';
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') outcome = 'timeout';
    throw e;
  } finally {
    const ms = Date.now() - started;
    if (ms > SLOW_CALL_MS) {
      void logToAxiom({
        name: 'user-workflows-slow',
        type: 'info',
        userId,
        source,
        ms,
        outcome,
      }).catch(() => null);
    }
  }
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.map(readWorkflow).filter((w): w is GeneratedWorkflow => w !== null),
    nextCursor: str(body.next),
  };
}
