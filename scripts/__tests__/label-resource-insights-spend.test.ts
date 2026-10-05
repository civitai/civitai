import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LABEL_BATCH_SIZE } from '../label-resource-insights';

/**
 * The run reports MEASURED spend.
 *
 * The decisions response carries the vendor's own `cost` for the request, which
 * `askJev` surfaces as `usage.costUsd`. The run accumulates that and prints it,
 * rather than deriving a figure from token counts and a price table — a derived
 * number drifts from the invoice silently, and the whole reason this run is
 * bounded is to keep spend predictable during validation, which an estimate
 * cannot do.
 *
 * A batch whose response carries no cost is counted SEPARATELY rather than
 * folded in as zero. Treating "not reported" as "free" understates the total,
 * and understating is the direction that matters for a budget bound — so the
 * printed line says how many batches the total actually covers.
 *
 * `askJev` is mocked, so no vendor request leaves the process; with no
 * `--execute` nothing is written either, and both are asserted.
 */

const versionFindMany = vi.fn();
const metricFindMany = vi.fn();
const resourceInsightFindMany = vi.fn();
const upsert = vi.fn();
const askJev = vi.fn();
const logged: string[] = [];

vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dbRead: {
    modelVersion: { findMany: (...a: unknown[]) => versionFindMany(...a) },
    modelVersionMetric: { findMany: (...a: unknown[]) => metricFindMany(...a) },
    resourceInsight: { findMany: (...a: unknown[]) => resourceInsightFindMany(...a) },
  },
  dbWrite: { resourceInsight: { upsert: (...a: unknown[]) => upsert(...a) } },
}));

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  askJev: (...a: unknown[]) => askJev(...a),
}));

type Question = { id: string; type: 'choice' | 'score' | 'noul' };

/** A well-formed response whose usage reports `costUsd` (or omits it). */
const respondWith = (costUsd?: number) => async (request: { questions: Question[] }) => ({
  answers: request.questions.map((question) =>
    question.type === 'score'
      ? { id: question.id, type: 'score' as const, value: 7, confidence: 0.8 }
      : {
          id: question.id,
          type: 'choice' as const,
          value: 'style',
          distribution: { style: 1 },
          confidence: 0.8,
        }
  ),
  model: 'test/jev',
  usage: {
    promptTokens: 470,
    completionTokens: 12,
    ...(costUsd !== undefined ? { costUsd } : {}),
  },
});

const version = (id: number) => ({
  id,
  // Deliberately a DIFFERENT id space from the version id: a fixture where
  // the two coincide cannot tell a model-id enqueue from a version-id one.
  modelId: 9000 + id,
  name: `Version ${id}`,
  baseModel: 'SDXL 1.0',
  trainedWords: ['trigger'],
  description: 'A test resource',
  model: { type: 'LORA', nsfw: false },
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

async function runTop(n: number) {
  const { main } = await import('../label-resource-insights');
  // argv[1] must not end with the script's filename or its tail guard
  // self-executes `main()`; only `slice(2)` is parsed.
  process.argv = ['node', 'vitest', '--top', String(n)];
  await main();
}

/** The final `done:` summary line. */
const summary = () => logged.find((line) => line.includes('done:')) ?? '';
/** The per-batch progress lines. */
const progressLines = () => logged.filter((line) => line.includes('labeled '));

describe('measured spend reporting', () => {
  let argv: string[];

  beforeEach(() => {
    logged.length = 0;
    versionFindMany.mockReset();
    metricFindMany.mockReset();
    resourceInsightFindMany.mockReset();
    upsert.mockReset();
    askJev.mockReset();
    metricFindMany.mockResolvedValue(
      ids(2 * LABEL_BATCH_SIZE).map((id) => ({ modelVersionId: id }))
    );
    resourceInsightFindMany.mockResolvedValue([]);
    versionFindMany.mockImplementation(async (args: { where: { id: { in: number[] } } }) =>
      args.where.id.in.map(version)
    );
    argv = process.argv;
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('accumulates the vendor-reported cost across batches into the summary', async () => {
    askJev.mockImplementation(respondWith(0.00002));

    await runTop(2 * LABEL_BATCH_SIZE);

    expect(askJev).toHaveBeenCalledTimes(2);
    // Two batches at 0.00002 each. Pinned as the literal total so a per-batch
    // overwrite, or a count that forgets a batch, both fail.
    expect(summary()).toContain('spent=$0.000040 over 2 batch(es)');
    expect(summary()).not.toContain('unreported');
  });

  it('reports the running total on each per-batch progress line', async () => {
    askJev.mockImplementation(respondWith(0.00002));

    await runTop(2 * LABEL_BATCH_SIZE);

    const lines = progressLines();
    expect(lines).toHaveLength(2);
    // Running, not per-batch: the second line must show both batches.
    expect(lines[0]).toContain('spent=$0.000020 over 1 batch(es)');
    expect(lines[1]).toContain('spent=$0.000040 over 2 batch(es)');
  });

  it('counts a batch that reported NO cost separately instead of as zero', async () => {
    askJev
      .mockImplementationOnce(respondWith(0.00002))
      .mockImplementationOnce(respondWith(undefined));

    await runTop(2 * LABEL_BATCH_SIZE);

    // The total covers one batch, and the line says so rather than implying it
    // covers the whole run.
    expect(summary()).toContain('spent=$0.000020 over 1 batch(es), 1 unreported');
  });

  it('reports a zero total honestly when no batch reported a cost', async () => {
    askJev.mockImplementation(respondWith(undefined));

    await runTop(2 * LABEL_BATCH_SIZE);

    expect(summary()).toContain('spent=$0.000000 over 0 batch(es), 2 unreported');
  });

  it('still writes nothing without --execute while metering', async () => {
    askJev.mockImplementation(respondWith(0.00002));

    await runTop(2 * LABEL_BATCH_SIZE);

    expect(upsert).not.toHaveBeenCalled();
  });
});
