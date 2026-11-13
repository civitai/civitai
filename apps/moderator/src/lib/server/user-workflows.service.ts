import { env } from '$env/dynamic/private';
import { MODERATOR_WORKFLOW_FILTER_MAX } from '@civitai/shared/moderator-paths';
import { logToAxiom } from './axiom';
import { mapBounded } from './bounded';
import { parseWorkflowId } from './workflow-id';

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

export type WorkflowOrigin = 'appblock' | 'onsite' | 'comfy' | 'untagged' | 'other';

/** Where a row came from, read from its own tags. App blocks also tag `gen`, so they are checked first:
 *  their trainings and step workflows keep no generation params. */
export function workflowOrigin(tags: string[]): WorkflowOrigin {
  if (tags.includes('app-block')) return 'appblock';
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

function managerBase(): { base: string; token: string } {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) throw new Error('Orchestrator is not configured.');
  return { base: endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint, token };
}

async function queryManagerWorkflows(
  query: URLSearchParams,
  timeoutMs: number
): Promise<{ items: unknown[] | null; next: string | null }> {
  const { base, token } = managerBase();
  const res = await fetch(`${base}/v1/manager/workflows?${query}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`The orchestrator refused the query (${res.status}).`);
  const body = (await res.json()) as { items?: unknown; next?: unknown };
  return { items: Array.isArray(body.items) ? body.items : null, next: str(body.next) };
}

export async function getUserGeneratedWorkflows(
  userId: number,
  options: { take?: number; cursor?: string | null; source?: WorkflowSource } = {}
): Promise<GeneratedWorkflowPage> {
  managerBase();
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
  let body: { items: unknown[] | null; next: string | null };
  try {
    body = await queryManagerWorkflows(query, ORCHESTRATOR_TIMEOUT_MS);
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
  return {
    items: (body.items ?? []).map(readWorkflow).filter((w): w is GeneratedWorkflow => w !== null),
    nextCursor: body.next,
  };
}

export const MAX_WORKFLOW_FILTER_IDS = MODERATOR_WORKFLOW_FILTER_MAX;
const BY_ID_CONCURRENCY = 8;
const BY_ID_CALL_TIMEOUT_MS = 20_000;
// Under Cloudflare's 100 s cut, with room for the slowest in-flight call to land.
const BY_ID_BUDGET_MS = 60_000;

export type WorkflowsByIdResult = {
  /** In the order they were asked for. */
  items: GeneratedWorkflow[];
  /** Not this account's, deleted, or past the orchestrator's retention. */
  notFound: string[];
  /** The orchestrator did not answer for these, so whether they exist is unknown. */
  unchecked: string[];
  /** Entries that are not workflow ids at all. */
  invalid: number;
  /** Valid ids past `cap`, not looked up. */
  overCap: number;
  cap: number;
};

/** Splits a `workflows=` value into distinct candidate ids, dropping empty entries. */
export const splitWorkflowIds = (raw: string): string[] => [
  ...new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  ),
];

/**
 * Exactly the listed workflows of one account, read through the same per-user listing the panel pages
 * — never the by-id GET, which reaches any workflow by id alone.
 *
 * The listing walks the account's ids newest-first starting AT `Cursor`, so `Take=1` from a workflow's
 * own id answers with that workflow. 🔴 A cursor the orchestrator does not accept as this user's is
 * ignored rather than refused, and the walk starts from the account's NEWEST workflow instead — so the
 * returned id must equal the requested one, or a missing id would show some other generation.
 */
export async function getUserWorkflowsByIds(
  userId: number,
  rawIds: string
): Promise<WorkflowsByIdResult> {
  managerBase();
  let invalid = 0;
  const valid: string[] = [];
  for (const id of splitWorkflowIds(rawIds)) {
    if (parseWorkflowId(id)) valid.push(id);
    else invalid += 1;
  }
  const wanted = valid.slice(0, MAX_WORKFLOW_FILTER_IDS);
  const overCap = valid.length - wanted.length;
  const own = wanted.filter((id) => parseWorkflowId(id)!.ownerId === userId);

  const answers = await mapBounded(
    own,
    async (id) => {
      const { items } = await queryManagerWorkflows(
        new URLSearchParams({ UserId: String(userId), Take: '1', Cursor: id }),
        BY_ID_CALL_TIMEOUT_MS
      );
      // A 2xx without a list is not an answer about the id, so it must not read as "not found".
      if (!items) throw new Error('The orchestrator answered without a workflow list.');
      const match = items.map(readWorkflow).find((w) => w?.id === id);
      return match ?? null;
    },
    { concurrency: BY_ID_CONCURRENCY, budgetMs: BY_ID_BUDGET_MS }
  );
  const byId = new Map(own.map((id, i) => [id, answers[i]]));

  const result: WorkflowsByIdResult = {
    items: [],
    notFound: [],
    unchecked: [],
    invalid,
    overCap,
    cap: MAX_WORKFLOW_FILTER_IDS,
  };
  for (const id of wanted) {
    const answer = byId.get(id);
    if (answer) result.items.push(answer);
    else if (answer === undefined && byId.has(id)) result.unchecked.push(id);
    else result.notFound.push(id);
  }
  return result;
}
