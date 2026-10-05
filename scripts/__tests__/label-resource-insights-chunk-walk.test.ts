import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LABEL_BATCH_SIZE } from '../label-resource-insights';

/**
 * How `--top` walks its materialised id list, and specifically its TERMINATOR.
 *
 * THE BUG THIS PINS. Both selection paths share one `versions.length === 0`
 * check, and the two paths mean different things by it. In the default keyset
 * path an empty page really is the end of the corpus, so it must stop. Under
 * `--top` the end of the run is the exhausted id LIST; an empty fetch there
 * only means every id in THAT chunk stopped being labelable since the list was
 * materialised, which is expected — ids are selected once, up front, and the
 * world moves underneath them. Letting the shared check `break` therefore ends
 * a bounded run at the first fully-dead chunk and silently drops every
 * remaining id, reporting ordinary success.
 *
 * It is pinned in the MIDDLE of the list on purpose: a dead FIRST chunk is
 * indistinguishable from "no labelable ids at all" and would still look
 * plausible under the broken terminator, so a guard that only covered the
 * first chunk would pass against the bug. Both positions are covered below so
 * the two cases stay distinguishable.
 *
 * This file mocks `askJev`, so chunks really are labeled rather than ending the
 * run early — that is the point, since the claim is about what happens AFTER a
 * dead chunk. No vendor request leaves the process and, with no `--execute`,
 * nothing is written; both are asserted rather than assumed.
 */

const versionFindMany = vi.fn();
const metricFindMany = vi.fn();
const resourceInsightFindMany = vi.fn();
const upsert = vi.fn();
const askJev = vi.fn();

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

/** Well-formed answers for whatever questions the batch asked. */
function answerEverything(request: { questions: Question[] }) {
  return {
    answers: request.questions.map((question) =>
      question.type === 'score'
        ? { id: question.id, type: 'score' as const, value: 7 }
        : {
            id: question.id,
            type: 'choice' as const,
            value: 'style',
            distribution: { style: 1 },
            confidence: 0.8,
          }
    ),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'test/jev',
  };
}

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

/** `n` ids starting at 1, i.e. exactly `n / LABEL_BATCH_SIZE` whole chunks. */
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const chunkOf = (index: number) =>
  ids(3 * LABEL_BATCH_SIZE).slice(index * LABEL_BATCH_SIZE, (index + 1) * LABEL_BATCH_SIZE);

/** The `where.id.in` of each version fetch the run issued, in order. */
function fetchedChunks(): unknown[] {
  return versionFindMany.mock.calls.map(
    (call) => (call[0] as { where: { id: { in: unknown } } }).where.id.in
  );
}

async function runTop(n: number) {
  const { main } = await import('../label-resource-insights');
  // argv[1] must not end with the script's filename or its tail guard
  // self-executes `main()`; only `slice(2)` is parsed.
  process.argv = ['node', 'vitest', '--top', String(n)];
  await main();
}

describe('--top chunk walk', () => {
  let argv: string[];

  beforeEach(() => {
    versionFindMany.mockReset();
    metricFindMany.mockReset();
    resourceInsightFindMany.mockReset();
    upsert.mockReset();
    askJev.mockReset();
    askJev.mockImplementation(async (request: { questions: Question[] }) =>
      answerEverything(request)
    );
    // Three whole chunks of ids, ranked.
    metricFindMany.mockResolvedValue(
      ids(3 * LABEL_BATCH_SIZE).map((id) => ({ modelVersionId: id }))
    );
    // No stored rows, so nothing is skipped as already-current.
    resourceInsightFindMany.mockResolvedValue([]);
    argv = process.argv;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('does NOT end the run when a MIDDLE chunk comes back fully dead', async () => {
    versionFindMany
      .mockResolvedValueOnce(chunkOf(0).map(version)) // chunk 1 — labelable
      .mockResolvedValueOnce([]) // chunk 2 — every id now unlabelable
      .mockResolvedValueOnce(chunkOf(2).map(version)); // chunk 3 — must still be reached

    await runTop(3 * LABEL_BATCH_SIZE);

    // The claim: all three chunks were fetched, so the dead middle one did not
    // terminate the walk. Under a `break` terminator this is 2.
    expect(versionFindMany).toHaveBeenCalledTimes(3);
    expect(fetchedChunks()).toEqual([chunkOf(0), chunkOf(1), chunkOf(2)]);
    // And the chunk AFTER the dead one was actually labeled, not merely fetched.
    expect(askJev).toHaveBeenCalledTimes(2);
  });

  it('does NOT end the run when the FIRST chunk comes back fully dead', async () => {
    versionFindMany
      .mockResolvedValueOnce([]) // chunk 1 — dead
      .mockResolvedValueOnce(chunkOf(1).map(version))
      .mockResolvedValueOnce(chunkOf(2).map(version));

    await runTop(3 * LABEL_BATCH_SIZE);

    expect(versionFindMany).toHaveBeenCalledTimes(3);
    expect(askJev).toHaveBeenCalledTimes(2);
  });

  it('terminates on the exhausted id list, not on a page count', async () => {
    versionFindMany.mockImplementation(async (args: { where: { id: { in: number[] } } }) =>
      args.where.id.in.map(version)
    );

    await runTop(3 * LABEL_BATCH_SIZE);

    // Exactly three chunks exist, so exactly three fetches — no speculative
    // fourth fetch past the end of the list.
    expect(versionFindMany).toHaveBeenCalledTimes(3);
    expect(askJev).toHaveBeenCalledTimes(3);
  });

  it('writes nothing without --execute, even though every chunk was labeled', async () => {
    versionFindMany.mockImplementation(async (args: { where: { id: { in: number[] } } }) =>
      args.where.id.in.map(version)
    );

    await runTop(3 * LABEL_BATCH_SIZE);

    expect(askJev).toHaveBeenCalledTimes(3);
    expect(upsert).not.toHaveBeenCalled();
  });
});
