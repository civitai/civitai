import type { Workflow } from '@civitai/orchestration-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowToDetail, workflowToRow } from '$lib/data/trainingRows';
import type { TrainingDetail } from '$lib/data/trainingRows';
import {
  assertNotWithheld,
  gateRows,
  RunWithheldError,
  withheldRuns,
  withholdDetail,
} from './withheld';

// The detail routes' composition: ask for the run, and hide its epochs if it comes back withheld.
const gateDetail = async (asker: typeof ASKER, detail: TrainingDetail) =>
  (await withheldRuns(asker, [detail.workflowId])).has(detail.workflowId)
    ? withholdDetail(detail)
    : detail;

vi.mock('@civitai/orchestration-client', () => ({}));

const mainApp = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const COOKIE = 'civ-token=x';
const ASKER = { cookie: COOKIE, userId: 7 };
const MARK = 'epoch-marker';

beforeEach(() => {
  vi.stubEnv('CIVITAI_URL', 'https://civitai.test');
  vi.stubGlobal('fetch', mainApp);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mainApp.mockReset();
});

const run = (id: string, meta: Record<string, unknown> = { modelId: 42 }, tags: string[] = []) =>
  ({
    id,
    status: 'succeeded',
    createdAt: '2026-09-01T00:00:00.000Z',
    tags: ['civitai', 'training', ...tags],
    metadata: { name: 'Run', media: 'image', cardType: 'sdxl', ...meta },
    steps: [
      {
        $type: 'training',
        input: { engine: 'ai-toolkit', ecosystem: 'sdxl', epochs: 1, samples: { prompts: ['p'] } },
        output: {
          epochs: [
            {
              epochNumber: 1,
              model: { id: `M-${MARK}.safetensors`, url: `https://x/m?${MARK}`, available: true },
              samples: [{ id: 'S1.png', url: `https://x/s?${MARK}`, available: true }],
            },
          ],
        },
      },
    ],
  } as unknown as Workflow);

const detailOf = (w: Workflow) => workflowToDetail(w)!;
const answer = (withheld: string[]) =>
  mainApp.mockImplementation(async () => Response.json({ withheld }));

describe('withheldRuns + withholdDetail', () => {
  it('hides every epoch sample, weight and key of a withheld run', async () => {
    answer(['wf-1']);
    const detail = detailOf(run('wf-1'));
    expect(JSON.stringify(detail)).toContain(MARK);
    const gated = await gateDetail(ASKER, detail);
    expect(JSON.stringify(gated)).not.toContain(MARK);
    expect(gated.epochs).toEqual([{ id: detail.epochs[0]!.id, number: 1, samples: [null] }]);
    expect(gated.name).toBe('Run');
    const [url, init] = mainApp.mock.calls[0]!;
    expect(url).toBe(
      'https://civitai.test/api/training-studio/model-status?workflowIds=wf-1&userId=7'
    );
    expect(new Headers(init.headers).get('cookie')).toBe(COOKIE);
  });

  // The main app answers a moderator, and any run it does not withhold, with an empty list.
  it('keeps everything for a run the main app does not withhold', async () => {
    answer([]);
    const detail = detailOf(run('wf-1'));
    expect(await gateDetail(ASKER, detail)).toEqual(detail);
  });

  it('asks by run id, so a rewritten modelId or tag cannot clear the gate', async () => {
    answer(['wf-1']);
    const rewritten = detailOf(run('wf-1', { modelId: undefined }, ['modelVersion:999']));
    const gated = await gateDetail(ASKER, rewritten);
    expect(JSON.stringify(gated)).not.toContain(MARK);
  });

  it.each([
    ['an error status', () => mainApp.mockResolvedValue(new Response('down', { status: 503 }))],
    ['a body without an answer', () => mainApp.mockResolvedValue(Response.json({ live: true }))],
    ['no response', () => mainApp.mockRejectedValue(new Error('timeout'))],
  ])('withholds when the main app gives %s', async (_label, fail) => {
    fail();
    const gated = await gateDetail(ASKER, detailOf(run('wf-1')));
    expect(JSON.stringify(gated)).not.toContain(MARK);
  });
});

describe('gateRows', () => {
  it('asks once for the whole list and clears only the withheld rows', async () => {
    answer(['wf-2']);
    const rows = ['wf-1', 'wf-2'].map((id) => workflowToRow(run(id))!);
    const gated = await gateRows(ASKER, rows);
    expect(mainApp).toHaveBeenCalledTimes(1);
    expect(mainApp.mock.calls[0]![0]).toContain('workflowIds=wf-1%2Cwf-2&userId=7');
    expect(gated[0]!.sampleUrls).toEqual(rows[0]!.sampleUrls);
    expect(gated[0]!.sampleUrls.length).toBeGreaterThan(0);
    expect(gated[1]!.sampleUrls).toEqual([]);
  });

  it('asks nothing for an empty list', async () => {
    expect(await gateRows(ASKER, [])).toEqual([]);
    expect(mainApp).not.toHaveBeenCalled();
  });
});

describe('assertNotWithheld', () => {
  it('refuses a withheld run and passes any other', async () => {
    answer(['wf-1']);
    await expect(assertNotWithheld(ASKER, 'wf-1')).rejects.toBeInstanceOf(RunWithheldError);
    await expect(assertNotWithheld(ASKER, 'wf-2')).resolves.toBeUndefined();
  });
});

describe('run ids outside the orchestrator charset', () => {
  it('are withheld without asking', async () => {
    answer([]);
    await expect(assertNotWithheld(ASKER, 'wf-1,wf-2')).rejects.toBeInstanceOf(RunWithheldError);
    expect(mainApp).not.toHaveBeenCalled();
  });
});
