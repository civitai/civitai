import { callModEndpoint } from '../user-actions.service';
import type { LabEntityType, LabField, LabScanResult, LabText } from '$lib/text-scan-lab/types';

/** The main app's text-scan harness (`/api/mod/text-scan`). Every scan is a billed workflow. */

/** The harness refuses more than this many texts or ids in one request. */
const HARNESS_BATCH_LIMIT = 50;
const HARNESS_TIMEOUT_MS = 150_000;

export class LabHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabHarnessError';
  }
}

async function callHarness<T>(
  action: string,
  params: Record<string, unknown>,
  label: string
): Promise<T> {
  const result = await callModEndpoint(
    'text-scan',
    { action, ...params },
    label,
    HARNESS_TIMEOUT_MS
  );
  if (!result.ok) throw new LabHarnessError(result.error);
  return result.body as T;
}

function chunk<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += HARNESS_BATCH_LIMIT)
    chunks.push(items.slice(i, i + HARNESS_BATCH_LIMIT));
  return chunks;
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
      elapsedMs: number;
    }
  | { key: string; ok: false; error: string };

function toLabScanResult(r: HarnessScanResult): LabScanResult {
  if (!r.ok) return { key: r.key, ok: false, error: r.error };
  return {
    key: r.key,
    ok: true,
    workflowId: r.workflowId,
    promptIds: r.promptIds,
    output: r.parse.ok ? r.parse.output : null,
    ...(r.parse.ok ? {} : { parseError: r.parse.reason }),
    elapsedMs: r.elapsedMs,
  };
}

/** Chunks run one after another so a large run never multiplies the harness's own concurrency. */
export async function scanTexts(
  entityType: LabEntityType,
  texts: LabText[],
  promptOverrides?: Record<string, string>
): Promise<LabScanResult[]> {
  const results: LabScanResult[] = [];
  for (const batch of chunk(texts)) {
    const body = await callHarness<{ results: HarnessScanResult[] }>(
      'scanTexts',
      { entityType, texts: batch, promptOverrides },
      'Text-scan scan'
    );
    results.push(...body.results.map(toLabScanResult));
  }
  return results;
}

export async function quoteTexts(
  entityType: LabEntityType,
  texts: LabText[],
  promptOverrides?: Record<string, string>
): Promise<{ meanCostTotal: number | null; count: number }> {
  let quoted = 0;
  let costSum = 0;
  for (const batch of chunk(texts)) {
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

export async function composeEntities(
  entityType: LabEntityType,
  ids: number[]
): Promise<LabComposedEntity[]> {
  const results: LabComposedEntity[] = [];
  for (const entityIds of chunk(ids)) {
    const body = await callHarness<{ results: LabComposedEntity[] }>(
      'composeEntities',
      { entityType, entityIds },
      'Load entity text'
    );
    results.push(...body.results);
  }
  return results;
}
