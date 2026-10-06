import { callModEndpoint } from '../user-actions.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { HARNESS_LIMITS, chunk, chunkTexts, textTooLarge } from '$lib/text-scan-lab/limits';
import type { LabEntityType, LabField, LabScanResult, LabText } from '$lib/text-scan-lab/types';

// The main app's text-scan harness (`/api/mod/text-scan`). Every scan is a billed workflow.

// One chunk is one wave (chunk size = concurrency), so a request takes at most one workflow wait, well
// inside the timeout and the harness's 120s budget; a timed-out request still bills every workflow it
// submitted.
const SCAN_CONCURRENCY = 8;
const SCAN_CHUNK_SIZE = SCAN_CONCURRENCY;
const SCAN_WAIT_SECONDS = 60;
const HARNESS_TIMEOUT_MS = 150_000;

export class LabHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabHarnessError';
  }
}

const postHarness = (action: string, params: Record<string, unknown>, label: string) =>
  callModEndpoint('text-scan', { action, ...params }, label, HARNESS_TIMEOUT_MS);

async function callHarness<T>(
  action: string,
  params: Record<string, unknown>,
  label: string
): Promise<T> {
  const result = await postHarness(action, params, label);
  if (!result.ok) throw new LabHarnessError(result.error);
  return result.body as T;
}

/** The harness reports a refused text by its position (`texts.7.fields`); name it by its key instead. */
const nameTexts = (error: string, batch: LabText[], keyLabel: string) =>
  error.replace(/\btexts\.(\d+)/g, (match, i: string) =>
    batch[Number(i)] ? `${keyLabel} ${batch[Number(i)].key}` : match
  );

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
export type LabPrompts = {
  active: Record<string, LabPrompt>;
  config: { model: string; maxInputChars: number; thinking: boolean };
  history?: LabPromptVersion[];
};

export const getPrompts = (history?: string) =>
  callHarness<LabPrompts>('getPrompts', history ? { history } : {}, 'Load text-scan prompts');

export const putPrompt = (key: string, content: string, note: string) =>
  callHarness<{ id: number; key: string }>(
    'putPrompt',
    { key, content, note },
    'Publish text-scan prompt'
  );

type HarnessScanResult =
  | {
      key: string;
      ok: true;
      workflowId: string;
      promptIds: Record<string, number>;
      parse: { ok: true; output: Record<string, unknown> } | { ok: false; reason: string };
      rawContent?: string;
      elapsedMs: number;
    }
  | { key: string; ok: false; error: string; workflowId?: string };

function toLabScanResult(r: HarnessScanResult): LabScanResult {
  if (!r.ok)
    return {
      key: r.key,
      ok: false,
      error: r.error,
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
  };
}

/**
 * Chunks run one after another. A failed chunk becomes a per-text error and the run continues,
 * because earlier chunks were already billed and the caller re-runs only what failed. It throws only
 * when the first request is refused outright (no session, not signed in, not allowed, invalid
 * request such as a blank prompt override): nothing was billed and every chunk would fail the same way.
 * A text over the harness limits is never sent; it comes back as its own error. Results keep the
 * order of `texts`.
 */
export async function scanTexts(
  entityType: LabEntityType,
  texts: LabText[],
  promptOverrides?: Record<string, string>,
  { keyLabel = 'text' }: { keyLabel?: string } = {}
): Promise<LabScanResult[]> {
  const { fitting, oversize } = splitOversize(texts);
  const byKey = new Map(oversize.map((r) => [r.key, r]));
  let sent = 0;
  for (const batch of chunkTexts(fitting, SCAN_CHUNK_SIZE)) {
    const result = await postHarness(
      'scanTexts',
      {
        entityType,
        texts: batch,
        promptOverrides,
        concurrency: SCAN_CONCURRENCY,
        wait: SCAN_WAIT_SECONDS,
      },
      'Text-scan scan'
    );
    sent++;
    if (result.ok) {
      for (const r of (result.body.results as HarnessScanResult[]).map(toLabScanResult))
        byKey.set(r.key, r);
      continue;
    }
    const error = nameTexts(result.error, batch, keyLabel);
    const refused =
      result.requestNeverSent ||
      result.status === 400 ||
      result.status === 401 ||
      result.status === 403;
    if (refused && sent === 1) throw new LabHarnessError(error);
    for (const { key } of batch) byKey.set(key, { key, ok: false, error });
  }
  return texts.flatMap(({ key }) => {
    const r = byKey.get(key);
    return r ? [r] : [];
  });
}

export async function quoteTexts(
  entityType: LabEntityType,
  texts: LabText[],
  promptOverrides?: Record<string, string>
): Promise<{ meanCostTotal: number | null; count: number }> {
  let quoted = 0;
  let costSum = 0;
  // An oversize text would refuse the whole request; it is left unquoted, as it will not run.
  for (const batch of chunkTexts(splitOversize(texts).fitting, HARNESS_LIMITS.textsPerRequest)) {
    const body = await callHarness<{ quoted: number; meanCostTotal: number | null }>(
      'quoteTexts',
      { entityType, texts: batch, promptOverrides },
      'Text-scan quote'
    );
    if (body.meanCostTotal === null) continue;
    quoted += body.quoted;
    costSum += body.meanCostTotal * body.quoted;
  }
  return { meanCostTotal: quoted ? costSum / quoted : null, count: texts.length };
}

export type LabComposedEntity =
  | { entityId: number; ok: true; fields: LabField[]; text: string; userId: number | null }
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
  if (!r.ok) return r;
  const fields = normaliseLabFields(r.fields);
  if (typeof fields === 'string') return { entityId: r.entityId, ok: false, error: fields };
  if (!fields.length) return { entityId: r.entityId, ok: false, error: 'too-short' };
  return { ...r, fields };
}

/** Fields come back normalised (no null or blank text), so every consumer can store or scan them as is. */
export async function composeEntities(
  entityType: LabEntityType,
  ids: number[]
): Promise<LabComposedEntity[]> {
  const results: LabComposedEntity[] = [];
  for (const entityIds of chunk(ids, HARNESS_LIMITS.textsPerRequest)) {
    const body = await callHarness<{ results: HarnessComposedEntity[] }>(
      'composeEntities',
      { entityType, entityIds },
      'Load entity text'
    );
    results.push(...body.results.map(toLabComposed));
  }
  return results;
}
