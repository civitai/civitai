import { callModEndpoint, callModEndpointAs, type JsonResult } from '../user-actions.service';
import { LabError } from './errors';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { chunk } from '$lib/text-scan-lab/chunk';
import { HARNESS_LIMITS, chunkTexts, textTooLarge } from '$lib/text-scan-lab/limits';
import type { LabEntityType, LabField, LabScanResult, LabText } from '$lib/text-scan-lab/types';

// A timed-out request still runs every workflow it submitted. One chunk is one wave of
// SCAN_CONCURRENCY, which stays under the harness's 120s budget.
const SCAN_CONCURRENCY = 8;
const SCAN_CHUNK_SIZE = SCAN_CONCURRENCY;
const SCAN_WAIT_SECONDS = 60;
const HARNESS_TIMEOUT_MS = 150_000;

export class LabHarnessError extends LabError {
  /** True when the request is known not to have taken effect (`isRejected` for a save, `isRefused` for a scan).
   *  `authRefused`: refused for the session itself (none to forward, 401, 403). */
  constructor(message: string, readonly refused = false, readonly authRefused = false) {
    super(message, 502);
  }
}

export class StalePromptError extends LabError {
  constructor(message: string) {
    super(message, 409);
  }
}

/** `credential`: a session cookie read earlier, for work that outlives its request. */
const postHarness = (
  action: string,
  params: Record<string, unknown>,
  label: string,
  credential?: string
) =>
  credential === undefined
    ? callModEndpoint('text-scan', { action, ...params }, label, HARNESS_TIMEOUT_MS)
    : callModEndpointAs(credential, 'text-scan', { action, ...params }, label, HARNESS_TIMEOUT_MS);

const isAuthRefusal = (result: JsonResult) =>
  !result.ok && (result.noSession === true || result.status === 401 || result.status === 403);

/** The request is known not to have taken effect: never sent, or rejected as invalid or unauthorised. */
export const isRefused = (result: JsonResult) =>
  !result.ok &&
  (result.requestNeverSent === true ||
    result.status === 400 ||
    result.status === 401 ||
    result.status === 403);

/** A write that was never sent or got any 4xx back did not happen; only a 5xx or a timeout leaves it unknown. */
export const isRejected = (result: JsonResult) =>
  !result.ok &&
  (result.requestNeverSent === true ||
    (result.status !== undefined && result.status >= 400 && result.status < 500));

async function callHarness<T>(
  action: string,
  params: Record<string, unknown>,
  label: string,
  credential?: string
): Promise<T> {
  const result = await postHarness(action, params, label, credential);
  if (!result.ok) throw new LabHarnessError(result.error, false, isAuthRefusal(result));
  return result.body as T;
}

/** The key Check gives pasted text, which the harness's errors would otherwise call "text text". */
export const FREE_TEXT_KEY = 'text';

/** The harness reports a refused text by its position (`texts.7.fields`); name it by its key instead. */
const nameTexts = (error: string, batch: LabText[]) =>
  error.replace(/\btexts\.(\d+)/g, (match, i: string) => {
    const key = batch[Number(i)]?.key;
    if (key === undefined) return match;
    return key === FREE_TEXT_KEY ? 'your text' : `item ${key}`;
  });

// The harness's per-item codes, in the words a moderator reads.
const PLAIN_ERRORS: Record<string, string> = {
  'too-short': 'not enough text to judge',
  'entity not found': 'not found',
};
const plainError = (error: string) => PLAIN_ERRORS[error] ?? error;

/** Texts the harness would refuse become their own errors, so they never sink a shared request. */
function splitOversize(texts: LabText[]) {
  const fitting: LabText[] = [];
  const oversize: LabScanResult[] = [];
  for (const text of texts) {
    const tooLarge = textTooLarge(text.fields);
    if (tooLarge) oversize.push({ key: text.key, ok: false, error: tooLarge });
    else fitting.push(text);
  }
  return { fitting, oversize };
}

export type LabPrompt = { id: number; key: string; content: string };
export type LabPromptVersion = LabPrompt & {
  note: string | null;
  createdById: number | null;
  createdAt: string;
};
export type LabPromptLatest = { id: number; createdAt: string; createdById: number | null };
export type LabPrompts = {
  active: Record<string, LabPrompt>;
  config: { model: string; maxInputChars: number; maxSegments?: number; thinking: boolean };
  history?: LabPromptVersion[];
  /** Absent from a main app older than the lab workspaces. */
  latest?: Record<string, LabPromptLatest>;
};

export const getPrompts = (history?: string) =>
  callHarness<LabPrompts>('getPrompts', history ? { history } : {}, 'Load text-scan prompts');

/** `baseId`: the version the draft started from (null: none); the save is refused if it moved. */
export async function putPrompt(
  key: string,
  content: string,
  opts: { note?: string; baseId?: number | null } = {}
): Promise<{ id: number; key: string }> {
  const result = await postHarness(
    'putPrompt',
    {
      key,
      content,
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.baseId !== undefined ? { baseId: opts.baseId } : {}),
    },
    'Save text-scan prompt'
  );
  if (result.ok) return result.body as { id: number; key: string };
  if (result.status === 409) throw new StalePromptError(result.reason ?? result.error);
  throw new LabHarnessError(result.error, isRejected(result));
}

type HarnessScanResult =
  | {
      key: string;
      ok: true;
      workflowId: string;
      promptIds: Record<string, number>;
      parse: { ok: true; output: Record<string, unknown> } | { ok: false; reason: string };
      rawContent?: string;
      elapsedMs: number;
      segments?: number;
    }
  | { key: string; ok: false; error: string; workflowId?: string };

function toLabScanResult(r: HarnessScanResult): LabScanResult {
  if (!r.ok)
    return {
      key: r.key,
      ok: false,
      error: plainError(r.error),
      ...(r.workflowId ? { workflowId: r.workflowId } : {}),
    };
  return {
    key: r.key,
    ok: true,
    workflowId: r.workflowId,
    promptIds: r.promptIds,
    output: r.parse.ok ? r.parse.output : null,
    ...(r.parse.ok ? {} : { parseError: r.parse.reason, rawContent: r.rawContent }),
    elapsedMs: r.elapsedMs,
    ...(r.segments && r.segments > 1 ? { segments: r.segments } : {}),
  };
}

export type LabOverrides = { prompts?: Record<string, string> };
export type LabRun = {
  results: LabScanResult[];
  system: string | null;
  /** A request after the first was refused for the session; its texts carry that refusal as errors. */
  authRefused?: true;
};

/**
 * Chunks run one after another. A failed chunk becomes a per-text error and the run continues,
 * because earlier chunks already scanned and the caller re-runs only what failed. It throws only
 * when the first request is refused outright (no session, not signed in, not allowed, invalid
 * request such as a blank prompt override): nothing was scanned and every chunk would fail the same way.
 * A text over the harness limits is never sent; it comes back as its own error. Results keep the
 * order of `texts`.
 */
export async function scanTexts(
  entityType: LabEntityType,
  texts: LabText[],
  overrides: LabOverrides = {},
  credential?: string
): Promise<LabRun> {
  const { fitting, oversize } = splitOversize(texts);
  const byKey = new Map(oversize.map((r) => [r.key, r]));
  let system: string | null = null;
  let sent = 0;
  let authRefused = false;
  for (const batch of chunkTexts(fitting, SCAN_CHUNK_SIZE)) {
    const result = await postHarness(
      'scanTexts',
      {
        entityType,
        texts: batch,
        promptOverrides: overrides.prompts,
        concurrency: SCAN_CONCURRENCY,
        wait: SCAN_WAIT_SECONDS,
      },
      'Text-scan scan',
      credential
    );
    sent++;
    if (result.ok) {
      const body = result.body as {
        results: HarnessScanResult[];
        system?: string | null;
      };
      system ??= body.system ?? null;
      for (const r of body.results.map(toLabScanResult)) byKey.set(r.key, r);
      continue;
    }
    const error = nameTexts(result.error, batch);
    const auth = isAuthRefusal(result);
    if (isRefused(result) && sent === 1) throw new LabHarnessError(error, false, auth);
    authRefused ||= auth;
    for (const { key } of batch) byKey.set(key, { key, ok: false, error });
  }
  return {
    results: texts.flatMap(({ key }) => {
      const r = byKey.get(key);
      return r ? [r] : [];
    }),
    system,
    ...(authRefused ? { authRefused: true as const } : {}),
  };
}

export type LabQuote = { count: number; quoted: number; maxCostTotal: number | null };

/** Prices a sample without scanning it. `credential`: see `postHarness`. */
export const quoteTexts = (
  entityType: LabEntityType,
  texts: LabText[],
  prompts: Record<string, string> | undefined,
  credential?: string
) =>
  callHarness<LabQuote>(
    'quoteTexts',
    {
      entityType,
      texts,
      ...(prompts && Object.keys(prompts).length ? { promptOverrides: prompts } : {}),
      concurrency: SCAN_CONCURRENCY,
    },
    'Text-scan quote',
    credential
  );

export type LabComposedEntity =
  | {
      entityId: number;
      ok: true;
      fields: LabField[];
      text: string;
      userId: number | null;
    }
  | { entityId: number; ok: false; error: string };

type HarnessComposedEntity =
  | {
      entityId: number;
      ok: true;
      fields: { heading: string; text: string | null }[];
      text: string;
      userId: number | null;
    }
  | { entityId: number; ok: false; error: string };

function toLabComposed(r: HarnessComposedEntity): LabComposedEntity {
  if (!r.ok) return { ...r, error: plainError(r.error) };
  const fields = normaliseLabFields(r.fields);
  if (typeof fields === 'string') return { entityId: r.entityId, ok: false, error: fields };
  if (!fields.length) return { entityId: r.entityId, ok: false, error: plainError('too-short') };
  return { ...r, fields };
}

export async function composeEntities(
  entityType: LabEntityType,
  ids: number[],
  credential?: string
): Promise<LabComposedEntity[]> {
  const results: LabComposedEntity[] = [];
  for (const entityIds of chunk(ids, HARNESS_LIMITS.textsPerRequest)) {
    const body = await callHarness<{ results: HarnessComposedEntity[] }>(
      'composeEntities',
      { entityType, entityIds },
      'Load entity text',
      credential
    );
    results.push(...body.results.map(toLabComposed));
  }
  return results;
}
