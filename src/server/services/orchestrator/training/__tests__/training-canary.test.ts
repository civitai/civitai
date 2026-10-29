import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as TrainingService from '~/server/services/training.service';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';

const mocks = vi.hoisted(() => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(async () => undefined),
  getTrainingServiceStatus: vi.fn(async () => ({ available: true, blockedModels: [] as string[] })),
  getOrchestratorToken: vi.fn(async () => 'canary-user-token'),
  fetch: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  submitWorkflow: mocks.submitWorkflow,
  getWorkflow: mocks.getWorkflow,
  cancelWorkflow: mocks.cancelWorkflow,
}));
vi.mock('~/server/services/training.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TrainingService>()),
  getTrainingServiceStatus: mocks.getTrainingServiceStatus,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: mocks.getOrchestratorToken,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  emptyCanaryState,
  evaluateCanaryWorkflow,
  pickLiveEntries,
  recordCanaryResult,
  resolveCanaryStep,
  runTrainingCanary,
  trainingCanaryConfigSchema,
  type TrainingCanaryState,
} from '~/server/services/orchestrator/training/training-canary';

const WEBHOOK = 'https://discord.test/canary';
const NOW = new Date('2026-10-27T12:00:00Z');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const config = (input: Record<string, unknown> = {}) => trainingCanaryConfigSchema.parse(input);

const LIVE_CONFIG = {
  liveEnabled: true,
  userId: 4242,
  datasets: { default: { url: 'https://datasets.test/canary.zip', imageCount: 8 } },
  matrix: [
    { key: 'sdxl', baseModel: 'sdxl', epochs: 2 },
    { key: 'flux', baseModel: 'flux_dev', epochs: 2 },
  ],
};

const epoch = (epochNumber: number, samples = 2) => ({
  epochNumber,
  model: { type: 'blob', id: `m${epochNumber}`, available: true },
  samples: Array.from({ length: samples }, (_, i) => ({
    type: 'image',
    id: `s${epochNumber}-${i}`,
    available: true,
  })),
});

const workflow = (over: Record<string, unknown> = {}) => ({
  id: 'wf-1',
  status: 'succeeded',
  createdAt: hoursBefore(2).toISOString(),
  completedAt: hoursBefore(1).toISOString(),
  cost: { total: 500 },
  steps: [{ output: { epochs: [epoch(1), epoch(2)] } }],
  ...over,
});

/**
 * Wires the two `KeyValue` rows the run reads. Each `upsert` is fed back as the next read, so
 * consecutive `runTrainingCanary()` calls behave like consecutive hourly ticks.
 */
function keyValues(initial: { config?: unknown; state?: TrainingCanaryState }) {
  const rows = new Map<string, unknown>();
  if (initial.config !== undefined) rows.set('training-canary:config', initial.config);
  if (initial.state !== undefined) rows.set('training-canary:state', initial.state);
  dbMock.dbWrite.keyValue.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null
  );
  dbMock.dbWrite.keyValue.upsert.mockImplementation(
    async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
      rows.set(where.key, JSON.parse(JSON.stringify(update.value)));
      return {};
    }
  );
  return { state: () => rows.get('training-canary:state') as TrainingCanaryState | undefined };
}

function discordPosts() {
  return mocks.fetch.mock.calls.map(([url, init]) => ({
    url,
    embed: JSON.parse(String((init as RequestInit).body)).embeds[0] as {
      title: string;
      description: string;
    },
  }));
}

const isWhatIf = (call: unknown[]) =>
  (call[0] as { query?: { whatif?: boolean } }).query?.whatif === true;
const liveSubmits = () => mocks.submitWorkflow.mock.calls.filter((call) => !isWhatIf(call));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  mocks.getTrainingServiceStatus.mockResolvedValue({ available: true, blockedModels: [] });
  mocks.submitWorkflow.mockImplementation(async ({ query }: { query?: { whatif?: boolean } }) =>
    query?.whatif ? { cost: { total: 300 } } : { id: 'wf-live-1' }
  );
  setEnv({ ORCHESTRATOR_ACCESS_TOKEN: 'system-token', DISCORD_WEBHOOK_TRAINING_CANARY: WEBHOOK });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('evaluateCanaryWorkflow', () => {
  const judge = (wf: ReturnType<typeof workflow>, submittedHoursAgo = 2) =>
    evaluateCanaryWorkflow(wf as never, {
      now: NOW,
      submittedAt: hoursBefore(submittedHoursAgo),
      timeoutHours: 8,
      expectedEpochs: 2,
    });

  it('passes a run with every checkpoint and samples, measuring wall time from submit', () => {
    expect(judge(workflow())).toMatchObject({ status: 'pass', durationMinutes: 60, cost: 500 });
  });

  it('fails a "succeeded" run that is missing checkpoints', () => {
    const result = judge(workflow({ steps: [{ output: { epochs: [epoch(1)] } }] }));
    expect(result).toMatchObject({ status: 'fail', detail: 'succeeded with 1/2 checkpoints' });
  });

  it('fails a "succeeded" run whose epoch produced no samples', () => {
    const result = judge(workflow({ steps: [{ output: { epochs: [epoch(1), epoch(2, 0)] } }] }));
    expect(result).toMatchObject({ status: 'fail', detail: 'epoch 2 has no samples' });
  });

  it('fails a run whose sample was blocked', () => {
    const blocked = epoch(2);
    blocked.samples[0] = { ...blocked.samples[0], blockedReason: 'minor' } as never;
    const result = judge(workflow({ steps: [{ output: { epochs: [epoch(1), blocked] } }] }));
    expect(result).toMatchObject({ status: 'fail', detail: 'sample blocked: minor' });
  });

  it('fails a terminal failure immediately', () => {
    expect(judge(workflow({ status: 'expired' }))).toMatchObject({
      status: 'fail',
      detail: 'workflow expired',
    });
  });

  it('waits on a running workflow inside its budget and fails it once past', () => {
    expect(judge(workflow({ status: 'processing' }), 7)).toBeNull();
    expect(judge(workflow({ status: 'processing' }), 9)).toMatchObject({
      status: 'fail',
      detail: 'stuck in "processing" after 9h',
    });
  });
});

describe('recordCanaryResult alerts on transitions only', () => {
  const at = NOW.toISOString();

  it('alerts once when an entry starts failing, stays quiet while it keeps failing, then reports recovery', () => {
    const state = emptyCanaryState();
    const fail = { status: 'fail' as const, at, detail: 'whatif rejected: boom' };

    expect(recordCanaryResult(state, 'sdxl', 'whatif', fail).map((a) => a.kind)).toEqual([
      'failing',
    ]);
    expect(recordCanaryResult(state, 'sdxl', 'whatif', fail)).toEqual([]);
    expect(
      recordCanaryResult(state, 'sdxl', 'whatif', { status: 'pass', at, cost: 300 }).map(
        (a) => a.kind
      )
    ).toEqual(['recovered']);
  });

  it('keeps whatif and live failures independent for the same entry', () => {
    const state = emptyCanaryState();
    recordCanaryResult(state, 'sdxl', 'whatif', { status: 'fail', at });
    expect(recordCanaryResult(state, 'sdxl', 'live', { status: 'fail', at })).toHaveLength(1);
  });

  it('reports a quote that changed price', () => {
    const state = emptyCanaryState();
    recordCanaryResult(state, 'sdxl', 'whatif', { status: 'pass', at, cost: 300 });
    const alerts = recordCanaryResult(state, 'sdxl', 'whatif', { status: 'pass', at, cost: 450 });
    expect(alerts).toEqual([expect.objectContaining({ kind: 'price-changed' })]);
    expect(alerts[0].message).toContain('300 → 450');
  });

  it('flags a live run over twice the median of recent successes', () => {
    const state = emptyCanaryState();
    for (const minutes of [60, 62, 58])
      expect(
        recordCanaryResult(state, 'sdxl', 'live', { status: 'pass', at, durationMinutes: minutes })
      ).toEqual([]);
    const alerts = recordCanaryResult(state, 'sdxl', 'live', {
      status: 'pass',
      at,
      durationMinutes: 150,
    });
    expect(alerts.map((a) => a.kind)).toEqual(['slow']);
  });
});

describe('pickLiveEntries', () => {
  const entries = config(LIVE_CONFIG).matrix;

  it('rotates through the matrix across ticks', () => {
    const first = pickLiveEntries(entries, [], 1, 0);
    const second = pickLiveEntries(entries, [], 1, first.cursor);
    const third = pickLiveEntries(entries, [], 1, second.cursor);
    expect([first, second, third].map((pick) => pick.entries[0]?.key)).toEqual([
      'sdxl',
      'flux',
      'sdxl',
    ]);
  });

  it('submits nothing while the pending cap is full, and never doubles up an in-flight entry', () => {
    const inFlight = [{ key: 'sdxl', workflowId: 'w', submittedAt: NOW.toISOString() }];
    expect(pickLiveEntries(entries, inFlight, 1, 0).entries).toEqual([]);
    expect(pickLiveEntries(entries, inFlight, 5, 0).entries.map((e) => e.key)).toEqual(['flux']);
  });
});

describe('resolveCanaryStep', () => {
  it('rejects a matrix entry naming a base model that cannot be trained', () => {
    const cfg = config({ matrix: [{ key: 'gone', baseModel: 'not_a_model' }] });
    expect(resolveCanaryStep(cfg.matrix[0], cfg, 'https://x.test/d.zip')).toEqual({
      ok: false,
      error: 'unknown base model "not_a_model"',
    });
  });

  it('builds the step the training form would, carrying the matrix epochs and dataset size', () => {
    const cfg = config(LIVE_CONFIG);
    const resolved = resolveCanaryStep(cfg.matrix[1], cfg, 'https://x.test/d.zip');
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.step.input).toMatchObject({
      engine: 'ai-toolkit',
      ecosystem: 'flux1',
      modelVariant: 'dev',
      epochs: 2,
      trainingData: { type: 'zip', sourceUrl: 'https://x.test/d.zip', count: 8 },
    });
  });
});

describe('runTrainingCanary', () => {
  it('with no config row, quotes the default matrix and spends nothing', async () => {
    const kv = keyValues({});

    const summary = await runTrainingCanary();

    expect(summary).toMatchObject({ quoted: 7, quoteFailures: 0, submitted: 0 });
    expect(mocks.submitWorkflow.mock.calls.every(isWhatIf)).toBe(true);
    expect(mocks.getOrchestratorToken).not.toHaveBeenCalled();
    expect(kv.state()?.entries.sdxl?.whatif).toMatchObject({ status: 'pass', cost: 300 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('posts a rejected quote to the canary channel once, not on every tick', async () => {
    keyValues({ config: { matrix: LIVE_CONFIG.matrix } });
    mocks.submitWorkflow.mockImplementation(async ({ body }: { body: { steps: unknown[] } }) => {
      const input = (body.steps[0] as { input: { ecosystem: string } }).input;
      if (input.ecosystem === 'flux1') throw new Error('ecosystem flux1 is not available');
      return { cost: { total: 300 } };
    });

    await runTrainingCanary();
    await runTrainingCanary();

    const posts = discordPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(WEBHOOK);
    expect(posts[0].embed.title).toBe('Training canary: 1 newly failing');
    expect(posts[0].embed.description).toContain(
      '**flux** [whatif] whatif rejected: ecosystem flux1 is not available'
    );
  });

  it('refuses an invalid config without submitting anything', async () => {
    keyValues({ config: { matrix: [] } });

    expect(await runTrainingCanary()).toMatchObject({ skipped: 'invalid-config' });
    expect(mocks.submitWorkflow).not.toHaveBeenCalled();
  });

  it('submits one live run per tick with the canary account, then judges it on a later tick', async () => {
    const kv = keyValues({ config: LIVE_CONFIG });

    await runTrainingCanary();

    expect(mocks.getOrchestratorToken).toHaveBeenCalledWith(4242);
    expect(liveSubmits()).toHaveLength(1);
    expect(liveSubmits()[0][0]).toMatchObject({
      token: 'canary-user-token',
      body: { tags: expect.arrayContaining(['training-canary', 'canary:sdxl']) },
    });
    expect(kv.state()?.pending).toEqual([
      { key: 'sdxl', workflowId: 'wf-live-1', submittedAt: NOW.toISOString() },
    ]);

    mocks.submitWorkflow.mockClear();
    mocks.getWorkflow.mockResolvedValue(workflow({ id: 'wf-live-1' }));
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));

    const summary = await runTrainingCanary();

    expect(summary).toMatchObject({ completed: 1, submitted: 1 });
    expect(kv.state()?.entries.sdxl?.live).toMatchObject({ status: 'pass', workflowId: 'wf-live-1' });
    expect(liveSubmits()[0][0]).toMatchObject({
      body: { tags: expect.arrayContaining(['canary:flux']) },
    });
  });

  it('cancels a stuck live run so it stops holding Buzz, and alerts', async () => {
    keyValues({
      config: LIVE_CONFIG,
      state: {
        ...emptyCanaryState(),
        pending: [{ key: 'sdxl', workflowId: 'wf-stuck', submittedAt: hoursBefore(9).toISOString() }],
      },
    });
    mocks.getWorkflow.mockResolvedValue(workflow({ id: 'wf-stuck', status: 'scheduled' }));

    await runTrainingCanary();

    expect(mocks.cancelWorkflow).toHaveBeenCalledWith({
      token: 'canary-user-token',
      workflowId: 'wf-stuck',
    });
    expect(discordPosts()[0].embed.description).toContain(
      '**sdxl** [live] stuck in "scheduled" after 9h (workflow wf-stuck)'
    );
  });

  it('submits no live run while training is disabled', async () => {
    keyValues({ config: LIVE_CONFIG });
    mocks.getTrainingServiceStatus.mockResolvedValue({ available: false, blockedModels: [] });

    await runTrainingCanary();

    expect(liveSubmits()).toEqual([]);
  });
});
