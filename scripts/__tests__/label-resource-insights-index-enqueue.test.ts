import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

/**
 * A WRITTEN LABEL MUST BE ANNOUNCED TO THE MODELS SEARCH INDEX.
 *
 * THE BUG THIS PINS. This script is the only writer of `ResourceInsight`, and it
 * used to enqueue nothing. The incremental models-index sync selects a model on
 * exactly three conditions — `Model.createdAt >= lastUpdatedAt`,
 * `Model.updatedAt >= lastUpdatedAt`, or the model sitting in the index's own
 * update queue (`prepareModelsBatches`, in
 * src/server/search-index/models.search-index.ts). A `ResourceInsight` upsert
 * satisfies NONE of them: it touches neither `Model` column. So a labeled model
 * was reachable only by the manual full re-projection, which can go a very long
 * time between runs — every insight attribute served from the index would be a
 * snapshot frozen at the last reset, with newly-labeled models seeded as
 * unlabeled and the gap widening from the moment the reset finished.
 *
 * Four claims, each able to be wrong on its own, so each is its own test:
 *
 *   1. A real write enqueues — ONE call for the batch, action `Update`.
 *   2. A dry run enqueues NOTHING. This is the half the arc has already been
 *      bitten by: `dryRun` gates the upsert, so the one call a dry run never
 *      makes is the one that was broken. A test exercising only the dry path
 *      would be green against the original defect.
 *   3. The ids are MODEL ids, not the `modelVersionId`s the table is keyed on.
 *      The queue takes a bare list of integers and cannot reject ids from the
 *      wrong space, so a version-id enqueue would silently re-index whichever
 *      unrelated models happened to share those numbers. Every fixture below
 *      therefore keeps the two id spaces disjoint — a fixture where a version id
 *      equals its model id cannot tell the two apart, and would pass against the
 *      wrong mapping.
 *   4. Several versions of one model collapse to ONE queue entry.
 *
 * Plus the cost decision: a failing enqueue must not be allowed to report the
 * batch as failed. The rows are already committed and the vendor has already
 * been paid for the request, so throwing would both misreport the batch and make
 * a resumed run re-spend on versions it had in fact labeled.
 *
 * `askJev` is mocked, so no vendor request leaves the process; `dbWrite` is
 * mocked, so nothing is written. Both are asserted rather than assumed.
 */

const versionFindMany = vi.fn();
const resourceInsightFindMany = vi.fn();
const upsert = vi.fn();
const askJev = vi.fn();
const queueUpdate = vi.fn();
const getQueue = vi.fn();
// `readOnly: true` means `checkoutQueue` hands back a no-op commit and retires
// nothing. Spied so the claim is behavioural, not just an argument match.
const commit = vi.fn();

vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dbRead: {
    modelVersion: { findMany: (...a: unknown[]) => versionFindMany(...a) },
    modelVersionMetric: { findMany: vi.fn() },
    resourceInsight: { findMany: (...a: unknown[]) => resourceInsightFindMany(...a) },
  },
  dbWrite: { resourceInsight: { upsert: (...a: unknown[]) => upsert(...a) } },
}));

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  askJev: (...a: unknown[]) => askJev(...a),
}));

// `importOriginal`, NOT a hand-listed mock — CLAUDE.md names this exact
// specifier as the example, and the five sibling suites already load the real
// barrel transitively through the script, so it demonstrably imports fine in
// this project. A hand-listed `{ modelsSearchIndex }` would break this file
// alone the first time the script imports a second export from it.
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  modelsSearchIndex: { queueUpdate: (...a: unknown[]) => queueUpdate(...a) },
}));

// The read-back the run does after its first announcement. Mocked at the module
// that owns it so the enqueue assertions below are not also asserting the
// verification, and so no redis command is attempted.
vi.mock('~/server/search-index/SearchIndexUpdate', async (importOriginal) => {
  const original = await importOriginal<{ SearchIndexUpdate: Record<string, unknown> }>();
  return {
    ...original,
    // Spread the real object, override ONE member. Replacing the whole export
    // would drop `queueUpdate`/`clearQueue`, which the real search-index barrel
    // (loaded here via `importOriginal`) calls — safe only by accident today,
    // which is the hazard the spread convention exists to remove.
    SearchIndexUpdate: {
      ...original.SearchIndexUpdate,
      getQueue: (...a: unknown[]) => getQueue(...a),
    },
  };
});

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

/**
 * `modelId` is passed in rather than derived: the point of these fixtures is
 * that the version id and the model id are independent, and two versions can
 * share a model.
 */
const version = (id: number, modelId: number) => ({
  id,
  modelId,
  name: `Version ${id}`,
  baseModel: 'SDXL 1.0',
  trainedWords: ['trigger'],
  description: 'A test resource',
  model: { type: 'LORA', nsfw: false },
});

/**
 * Three versions over TWO models, with the two id spaces deliberately disjoint
 * (versions 1–3, models 500/600) and one model carrying two versions. One
 * fixture exercises the mapping and the dedup at once, and no assertion below
 * can be satisfied by echoing a version id back.
 */
const PAGE = [version(1, 500), version(2, 500), version(3, 600)];

async function run(...args: string[]) {
  const { main } = await import('../label-resource-insights');
  // argv[1] must not end with the script's filename or its tail guard
  // self-executes `main()`; only `slice(2)` is parsed.
  process.argv = ['node', 'vitest', ...args];
  await main();
}

/** Every id/action pair handed to the queue, flattened across calls. */
function queuedItems(): unknown[] {
  return queueUpdate.mock.calls.flatMap((call) => call[0] as unknown[]);
}

describe('label writes are announced to the models search index', () => {
  let argv: string[];
  // Captured as plain string arrays rather than kept as spy handles: reading
  // `spy.mock.calls` off a `ReturnType<typeof vi.spyOn>` loses the generic and
  // every callback lands as an implicit `any`, which `tsconfig.scripts.json`
  // reports (`node scripts/ci/typecheck-scripts-gate.mjs` is what sees this file).
  const logged: string[] = [];
  const warned: string[] = [];

  beforeEach(() => {
    versionFindMany.mockReset();
    resourceInsightFindMany.mockReset();
    upsert.mockReset();
    askJev.mockReset();
    queueUpdate.mockReset();
    getQueue.mockReset();
    commit.mockReset();
    commit.mockResolvedValue(undefined);
    askJev.mockImplementation(async (request: { questions: Question[] }) =>
      answerEverything(request)
    );
    // Default: the read-back finds both announced models, i.e. the healthy case.
    getQueue.mockResolvedValue({ content: [500, 600], commit });
    // No stored rows, so nothing is skipped as already-current.
    resourceInsightFindMany.mockResolvedValue([]);
    versionFindMany.mockResolvedValue(PAGE);
    upsert.mockResolvedValue(undefined);
    queueUpdate.mockResolvedValue(undefined);
    argv = process.argv;
    logged.length = 0;
    warned.length = 0;
    // EVERY argument, joined — not just `args[0]`. The enqueue-failure warn
    // passes the error detail as a second argument, and capturing only the
    // first makes a mutation that drops or mislabels it unobservable.
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('enqueues the affected models once per batch when rows are written', async () => {
    await run('--execute', '--limit', '3');

    // The write happened — otherwise there would be nothing to announce and
    // this test would pass vacuously.
    expect(upsert).toHaveBeenCalledTimes(3);
    // ONE call for the batch, not one per row: `queueUpdate` takes a list.
    expect(queueUpdate).toHaveBeenCalledTimes(1);
    expect(queueUpdate).toHaveBeenCalledWith([
      { id: 500, action: SearchIndexUpdateQueueAction.Update },
      { id: 600, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('announces AFTER the rows are written, never before', async () => {
    await run('--execute', '--limit', '3');

    // The ordering is a stated design point — a queue entry is supposed to mean
    // "a row exists to index", so enqueuing first would queue models whose
    // upserts then failed. Asserted on invocation order because
    // `toHaveBeenCalledTimes` is blind to it: moving the whole enqueue block
    // above the upserts leaves every other assertion in this file green.
    // 🔴 NEGATIVE CONTROL FIRST. `Math.max(...[])` is `-Infinity`, so if the
    // upserts stopped happening altogether the comparison below would be
    // SATISFIED rather than broken — the test would go green on a worse bug.
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(queueUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...upsert.mock.invocationCallOrder)
    );
  });

  it('enqueues MODEL ids, never the modelVersionIds the labels are keyed on', async () => {
    await run('--execute', '--limit', '3');

    const ids = queuedItems().map((item) => (item as { id: number }).id);
    expect(ids).toEqual([500, 600]);
    // Stated separately and in the negative: the queue cannot reject an id from
    // the wrong space, so this is the only thing that would catch the mapping
    // being dropped while the enqueue itself still looked healthy.
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
  });

  it('deduplicates two versions of one model into a single queue entry', async () => {
    await run('--execute', '--limit', '3');

    const ids = queuedItems().map((item) => (item as { id: number }).id);
    // Model 500 owns versions 1 and 2. Three labels, two queue entries.
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(ids).toHaveLength(2);
    expect(ids.filter((id) => id === 500)).toHaveLength(1);
  });

  it('enqueues NOTHING on a dry run, even though the batch was labeled', async () => {
    await run('--limit', '3');

    // The batch really was judged — this is not a run that did nothing.
    expect(askJev).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('reports how many models it announced, per batch and in the summary', async () => {
    await run('--execute', '--limit', '3');

    // Both lines, because the file header promises both and each can be
    // deleted on its own — the summary total alone stays green when the
    // per-batch `queued N` segment is removed.
    expect(logged.join('\n')).toContain('queued 2,');
    expect(logged.join('\n')).toContain('2 models queued for reindex');
  });

  it('keeps the batch successful when the enqueue fails — the rows and the spend are already gone', async () => {
    queueUpdate.mockRejectedValue(new Error('queue unavailable'));

    // The decision: a failed announcement must not propagate. Throwing would
    // reach `main`'s per-batch catch, which counts every version in the batch
    // as failed, and a resumed run would re-pay the vendor for them.
    //
    // ⚠️ `resolves` is NOT the discriminator here — `main` already swallows a
    // batch throw in its own per-batch catch, so it resolves either way. The
    // claim is carried by the counts and the warn below.
    await expect(run('--execute', '--limit', '3')).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(logged.join('\n')).toContain('3 labeled, 0 failed');
    // 🔴 And the count must NOT claim the failed announcement: this is what
    // stops `enqueuedModelIds` being assigned before the call it reports on.
    expect(logged.join('\n')).toContain('0 models queued for reindex');
    // Not silent either — the ids are logged, because a resumed run skips these
    // versions as already-current and will never retry the enqueue.
    expect(warned.join('\n')).toContain('enqueue FAILED for model ids 500,600');
    // Nothing was announced, so there is nothing to verify: dropping the
    // `enqueuedModelIds.length > 0` gate on the read-back would print a
    // stray `queue-verify: nothing enqueued yet` here.
    expect(logged.join('\n')).not.toContain('queue-verify');
    expect(getQueue).not.toHaveBeenCalled();
  });

  it('does not announce a model whose only version in the batch failed to map', async () => {
    // Resource 2 is version 3, the sole version of model 600. Withholding its
    // answers makes `parseLabelAnswers` fail that resource, so no row is written
    // for it — and an announcement for 600 would be an announcement about a row
    // that does not exist.
    //
    // 🔴 This is the END-TO-END half of the claim. The direct `labeledModelIds`
    // test below pins the function; it cannot see the CALL SITE, so deriving the
    // ids from the fetched page instead of from the written rows leaves it green
    // (measured — that mutant survived until this test existed).
    askJev.mockImplementation(async (request: { questions: Question[] }) => {
      const full = answerEverything(request);
      return { ...full, answers: full.answers.filter((a) => !a.id.startsWith('r2.')) };
    });

    await run('--execute', '--limit', '3');

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(queueUpdate).toHaveBeenCalledWith([
      { id: 500, action: SearchIndexUpdateQueueAction.Update },
    ]);
    const ids = queuedItems().map((item) => (item as { id: number }).id);
    expect(ids).not.toContain(600);
  });

  it('names the models at risk when the upserts fail part-way through', async () => {
    // `limitConcurrency` rejects on the first task error and there is no
    // transaction, so earlier upserts are already COMMITTED. The batch is then
    // counted as failed and a resumed run skips those rows as already-current,
    // so nothing ever announces them. This log line is the only record.
    upsert.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('write conflict'));

    await expect(run('--execute', '--limit', '3')).resolves.toBeUndefined();

    expect(warned.join('\n')).toContain('some rows may be committed WITHOUT an index announcement');
    expect(warned.join('\n')).toContain('Candidate model ids to re-queue by hand: 500,600');
    // And the run does not pretend to have announced anything.
    expect(logged.join('\n')).toContain('0 models queued for reindex');
  });

  describe('the queue read-back', () => {
    it('confirms the announcement landed, and reads the RIGHT queue read-only', async () => {
      await run('--execute', '--limit', '3');

      expect(logged.join('\n')).toContain('queue-verify: all 2 model id(s)');
      expect(logged.join('\n')).toContain('announcements are landing');
      // 🔴 THE ARGUMENTS, not just the call. All three matter and none of them
      // is observable from the message: the wrong index constant reads a queue
      // this script never writes to (permanently INCONCLUSIVE, reported as a
      // working verifier), `Delete` likewise, and dropping `readOnly` makes
      // `checkoutQueue` APPEND a bucket and hand back a `commit` that retires
      // every bucket it read — i.e. the diagnostic would start consuming the
      // work it exists to confirm.
      expect(getQueue).toHaveBeenCalledWith(
        MODELS_SEARCH_INDEX,
        SearchIndexUpdateQueueAction.Update,
        true
      );
      // And the behavioural half of `readOnly`: nothing is ever committed.
      expect(commit).not.toHaveBeenCalled();
    });

    it('reads back ONCE per run, not once per announcing batch', async () => {
      // 🔴 Two announcing batches. Every other test runs `--limit 3` against a
      // 3-version page, which is ONE batch — and with one batch "once per run"
      // and "once per batch" are indistinguishable, so the one-shot flag could
      // be deleted and the suite would stay green. `versionFindMany` is a
      // persistent mock, so `--limit 6` yields two batches.
      await run('--execute', '--limit', '6');

      expect(queueUpdate).toHaveBeenCalledTimes(2);
      expect(getQueue).toHaveBeenCalledTimes(1);
      // The read-back follows the announcement it is checking, not precedes it.
      expect(getQueue.mock.invocationCallOrder[0]).toBeGreaterThan(
        queueUpdate.mock.invocationCallOrder[0]
      );
      // And the summary ACCUMULATES across batches rather than reporting the last.
      expect(logged.join('\n')).toContain('4 models queued for reindex');
    });

    it('reports INCONCLUSIVE rather than success when the ids are not in the queue', async () => {
      // The fail-open shape: `queueUpdate` resolved, so `queued N` is fully
      // populated, and the ids are nowhere near the queue. This is the case the
      // count alone cannot see, and the only reason the read-back exists.
      getQueue.mockResolvedValue({ content: [], commit });

      await run('--execute', '--limit', '3');

      expect(logged.join('\n')).toContain('2 models queued for reindex');
      expect(logged.join('\n')).toContain('queue-verify: INCONCLUSIVE — 0/2 model id(s)');
      expect(logged.join('\n')).not.toContain('announcements are landing');
    });

    it('treats a PARTIAL match as inconclusive, not as success', async () => {
      // 🔴 The boundary case, and the only one that pins `found === length`
      // rather than `found > 0`: with only the all-present and none-present
      // fixtures, relaxing the comparison to `found > 0` passes both — and in
      // production would report "announcements are landing" for a run where 1
      // id in 500 was found, turning the one signal a fail-open enqueue has
      // into a green light.
      getQueue.mockResolvedValue({ content: [500], commit });

      await run('--execute', '--limit', '3');

      expect(logged.join('\n')).toContain('queue-verify: INCONCLUSIVE — 1/2 model id(s)');
      expect(logged.join('\n')).not.toContain('announcements are landing');
    });

    it('does not fail the run when the read-back itself throws', async () => {
      getQueue.mockRejectedValue(new Error('queue read refused'));

      await expect(run('--execute', '--limit', '3')).resolves.toBeUndefined();

      expect(logged.join('\n')).toContain('queue-verify: could not read the queue back');
      // The labeling itself still succeeded — a diagnostic must not fail a paid batch.
      expect(logged.join('\n')).toContain('3 labeled, 0 failed');
    });

    it('does not read the queue back on a dry run', async () => {
      await run('--limit', '3');

      expect(getQueue).not.toHaveBeenCalled();
    });

    it('says nothing-enqueued rather than claiming a verdict on an empty set', async () => {
      const { verifyFirstEnqueue } = await import('../label-resource-insights');

      // Unreachable from the call site today (it is gated on a non-empty set),
      // so pinned directly: a guard that returns a confident "all 0 … landing"
      // on an empty list is exactly the reassuring zero this whole read-back
      // exists to avoid.
      await expect(verifyFirstEnqueue([])).resolves.toContain('nothing enqueued yet');
      expect(getQueue).not.toHaveBeenCalled();
    });
  });

  describe('runAsScript', () => {
    // 🔴 The most operationally consequential lines in the change, and the only
    // ones unreachable through `main`: the process can no longer end on its own
    // (the redis clients connect at module load and arm a ping interval), and
    // `process.exit` does NOT drain piped stdout — measured, a bare exit lost
    // the final line in 3 of 3 piped runs. The final line carries the resume
    // cursor for a run that spends vendor money per batch, so losing it means
    // re-paying. `exit` and `flush` are injected precisely so this is testable.

    it('flushes BEFORE exiting 0 on success', async () => {
      const { runAsScript } = await import('../label-resource-insights');
      const exit = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      process.argv = ['node', 'vitest', '--execute', '--limit', '3'];

      await runAsScript(exit, flush);

      expect(exit).toHaveBeenCalledWith(0);
      // Order is the whole point: a flush after the exit is inert, and no other
      // assertion here could tell the difference.
      expect(flush.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
      // Negative control — the run really did happen, so this is not vacuous.
      expect(logged.join('\n')).toContain('3 labeled, 0 failed');
    });

    it('flushes BEFORE exiting 1 when the run throws', async () => {
      const { runAsScript } = await import('../label-resource-insights');
      const exit = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      versionFindMany.mockRejectedValue(new Error('read refused'));
      process.argv = ['node', 'vitest', '--execute', '--limit', '3'];

      await runAsScript(exit, flush);

      expect(error).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).not.toHaveBeenCalledWith(0);
      // Same reason as above: a truncated stderr loses the stack.
      expect(flush.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    });
  });
});

describe('labeledModelIds', () => {
  const page = [version(1, 500), version(2, 500), version(3, 600)];

  it('is driven by the labels written, not by the page fetched', async () => {
    const { labeledModelIds } = await import('../label-resource-insights');

    // Version 3 was fetched but its answers did not map, so no row exists for
    // it — model 600 must NOT be announced on the strength of a row that is not
    // there. Deriving the ids from `versions` instead returns [500, 600] and
    // every end-to-end assertion in this file stays green, because the fixtures
    // there label every version.
    const ids = labeledModelIds(page, [
      { modelVersionId: 1 },
      { modelVersionId: 2 },
    ] as never as Parameters<typeof labeledModelIds>[1]);

    expect(ids).toEqual([500]);
  });

  it('skips a label whose version is absent from the page rather than enqueuing undefined', async () => {
    const { labeledModelIds } = await import('../label-resource-insights');

    const ids = labeledModelIds(page, [
      { modelVersionId: 1 },
      { modelVersionId: 99 },
    ] as never as Parameters<typeof labeledModelIds>[1]);

    // 99 maps to nothing; the result carries 500 only, and no `undefined`.
    expect(ids).toEqual([500]);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
  });

  it('collapses several versions of one model to a single id', async () => {
    const { labeledModelIds } = await import('../label-resource-insights');

    const ids = labeledModelIds(page, [
      { modelVersionId: 1 },
      { modelVersionId: 2 },
      { modelVersionId: 3 },
    ] as never as Parameters<typeof labeledModelIds>[1]);

    expect(ids).toEqual([500, 600]);
  });
});
