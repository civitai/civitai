import { describe, expect, it } from 'vitest';
import type { TransactionInfo, Workflow, WorkflowTemplate } from '@civitai/orchestration-client';
import {
  RETRAIN_HARD_STOP,
  runRetrainSource,
  type OwnerOrchestrator,
  type RetrainDeps,
} from '~/server/services/orchestrator/training/training-retrain';

// The orchestrator and the gates are fakes behind the injected deps; every rule runs for real. The
// fake refund keys each colour as the orchestrator does (`refund-all-<colour>-<id>`), so a repeat
// pays only a colour still owed, and it can fail a colour after setting `forceRefunded`, which is
// the order the orchestrator uses.

const OWNER = 5501;
const SOURCE = `${OWNER}-20261120183000123-ab12`;
const NOW = new Date('2026-11-22T10:00:00Z');
const BASE_AIR = 'urn:air:sdxl:checkpoint:civitai:101@202';
const BLOB = (n: number) => `urn:air:sdxl:blob:orchestrator:${n}@blobkey${n}`;

/** Every field a Kohya submit sends, each with a value, so a key dropped from the replay shows. */
const REPLAYED_INPUT = {
  engine: 'kohya',
  model: BASE_AIR,
  maxTrainEpochs: 10,
  steps: 1200,
  numRepeats: 4,
  trainBatchSize: 2,
  resolution: 1024,
  enableBucket: true,
  shuffleCaption: false,
  keepTokens: 1,
  clipSkip: 1,
  flipAugmentation: false,
  unetLR: 0.0005,
  textEncoderLR: 0.00005,
  trainTextEncoder: false,
  lrScheduler: 'cosine_with_restarts',
  lrSchedulerNumCycles: 3,
  minSnrGamma: 5,
  networkDim: 32,
  networkAlpha: 16,
  noiseOffset: 0.1,
  optimizerType: 'AdamW8Bit',
  seed: 1234,
  fp8Base: false,
  blocksToSwap: 0,
  vParameterization: false,
  zeroTerminalSnr: false,
  trainingData: { type: 'blobs', items: [{ air: BLOB(1) }, { air: BLOB(2) }] },
  samples: { prompts: ['a photo of mylora'] },
  clipLModel: 'urn:air:sdxl:clip:civitai:1@1',
  textEncoderModel: 'urn:air:sdxl:te:civitai:2@2',
  vaeModel: 'urn:air:sdxl:vae:civitai:3@3',
};

function sourceRun(over: Partial<Workflow> & { studio?: boolean } = {}): Workflow {
  const { studio = true, ...rest } = over;
  return {
    id: SOURCE,
    createdAt: '2026-11-20T18:30:00Z',
    status: 'succeeded',
    forceRefunded: false,
    tags: studio ? ['civitai', 'training', 'name:my-lora', 'submit:00ff00ff00ff00ff'] : ['own-tag'],
    metadata: studio
      ? {
          name: 'My LoRA',
          trigger: 'mylora',
          v: 3,
          published: true,
          modelId: 77,
          modelVersionId: 88,
        }
      : {},
    currencies: ['blue', 'yellow'],
    allowMatureContent: false,
    callbacks: [{ url: 'https://old.example/callback', type: ['step:*'] }],
    transactions: {
      list: [
        { type: 'debit', amount: 300, accountType: 'blue', id: 't1' },
        { type: 'debit', amount: 200, accountType: 'yellow', id: 't2' },
      ],
    },
    steps: [
      {
        $type: 'training',
        input: {
          ...REPLAYED_INPUT,
          // Read-only values the orchestrator echoes back and refuses on submit.
          defaultSteps: 1000,
          storageBuzzPerEpoch: 5,
        },
      },
    ],
    ...rest,
  } as unknown as Workflow;
}

type World = ReturnType<typeof createWorld>;

function createWorld(
  source: Workflow,
  opts: { quote?: number; nsfw?: Record<string, string | null> } = {}
) {
  const runs = new Map<string, Workflow>([[source.id as string, structuredClone(source)]]);
  const byExternalId = new Map<string, Workflow>();
  const refundKeys = new Set<string>();
  const calls = { refund: 0, quote: 0, submit: 0, quoteBodies: [] as WorkflowTemplate[] };
  /** Colours whose refund fails on the next /refund call, after the flag is set. */
  const failColours = new Set<string>();
  let allowlist: Record<string, string> = { [SOURCE]: 'retrain' };
  let allowlistDown = false;
  let kohyaFlag = true;
  /** A gate that refuses: `withheld: true`, or the refusal text of the others. */
  const refuse: Partial<
    Record<'withheld' | 'training' | 'triggerWord' | 'license', string | boolean>
  > = {};
  let clock = NOW;
  let seq = 0;

  const orchestrator: OwnerOrchestrator = {
    read: async (id) => {
      const run = runs.get(id);
      return run ? { status: 200, workflow: structuredClone(run) } : { status: 404 };
    },
    quote: async (body) => {
      calls.quote++;
      calls.quoteBodies.push(body);
      return { status: 200, workflow: { cost: { total: opts.quote ?? 480 } } as Workflow };
    },
    submit: async (body) => {
      calls.submit++;
      const key = `${OWNER}-${body.externalId}`;
      const existing = byExternalId.get(key);
      if (existing) return { status: 200, workflow: structuredClone(existing) };
      const run = {
        id: `${OWNER}-2026112210000${String(seq++).padStart(4, '0')}-zz99`,
        createdAt: clock.toISOString(),
        status: 'unassigned',
        externalId: key,
        transactions: { list: [{ type: 'debit', amount: opts.quote ?? 480, accountType: 'blue' }] },
      } as unknown as Workflow;
      byExternalId.set(key, run);
      runs.set(run.id as string, run);
      return { status: 200, workflow: structuredClone(run) };
    },
    blobNsfwLevel: async (air) => (opts.nsfw && air in opts.nsfw ? opts.nsfw[air] : ''),
  };

  const deps: RetrainDeps = {
    now: () => clock,
    readAllowlist: async (id) => {
      if (allowlistDown) throw new Error('sysRedis down');
      return allowlist[id] ?? null;
    },
    ownerOrchestrator: async () => orchestrator,
    forceRefund: async (id) => {
      calls.refund++;
      const run = runs.get(id);
      if (!run) return 404;
      run.forceRefunded = true;
      run.status = 'failed';
      const list = run.transactions?.list as TransactionInfo[];
      const debits = new Map<string, number>();
      for (const t of list)
        if (t.type === 'debit')
          debits.set(t.accountType, (debits.get(t.accountType) ?? 0) + t.amount);
      for (const [colour, amount] of debits) {
        const key = `refund-all-${colour}-${id}`;
        if (refundKeys.has(key)) continue;
        if (failColours.delete(colour)) continue;
        refundKeys.add(key);
        list.push({
          type: 'credit',
          amount,
          accountType: colour as TransactionInfo['accountType'],
        });
      }
      return 204;
    },
    callbacksFor: (userId) => [
      { url: `https://signals.example/users/${userId}`, type: ['step:*'] },
    ],
    gates: {
      withheld: async () => refuse.withheld === true,
      training: async () => (refuse.training as string) ?? null,
      studioKohya: async () => kohyaFlag,
      triggerWord: async () => (refuse.triggerWord as string) ?? null,
      license: async () => (refuse.license as string) ?? null,
    },
  };

  return {
    deps,
    runs,
    calls,
    failColours,
    refuse,
    refundKeys,
    setAllowlist: (a: Record<string, string>) => (allowlist = a),
    setAllowlistDown: () => (allowlistDown = true),
    setKohyaFlag: (on: boolean) => (kohyaFlag = on),
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    run: (execute: boolean, retrainWorkflowId?: string) =>
      runRetrainSource({ sourceWorkflowId: SOURCE, execute, retrainWorkflowId }, deps),
  };
}

const credited = (w: World) =>
  (w.runs.get(SOURCE)?.transactions?.list ?? []).filter((t) => t.type === 'credit');

describe('runRetrainSource', () => {
  it('dry-runs the same Studio run again: its settings without echoed keys, low priority, fresh callbacks, a new name, no money moved', async () => {
    const w = createWorld(sourceRun());
    const result = await w.run(false);

    expect(result.outcome).toBe('would-retrain');
    expect(result.refundNetByColour).toEqual({ blue: 300, yellow: 200 });
    const body = result.body!;
    const step = body.steps[0] as unknown as { priority: string; input: Record<string, unknown> };
    expect(step.priority).toBe('low');
    expect(step.input).toEqual(REPLAYED_INPUT);
    expect(body.externalId).toBe(`retrain-${SOURCE}`);
    expect(body.tags).toEqual(['civitai', 'training', 'name:my-lora']);
    expect(body.callbacks).toEqual([
      { url: `https://signals.example/users/${OWNER}`, type: ['step:*'] },
    ]);
    // The source's model links stay with the source.
    expect(body.metadata).toEqual({
      name: 'My LoRA (retrain)',
      trigger: 'mylora',
      v: 3,
      sourceWorkflowId: SOURCE,
      retrainOf: SOURCE,
    });
    expect(body.upgradeMode).toBe('manual');
    expect(body.currencies).toEqual(['blue', 'yellow']);
    // The quote never carries the idempotency key.
    expect(w.calls.quoteBodies[0]).not.toHaveProperty('externalId');
    expect(w.calls.refund + w.calls.submit).toBe(0);
  });

  it('replays an API run with its own tags, no Studio metadata or callbacks, and without the Studio Kohya flag', async () => {
    const w = createWorld(sourceRun({ studio: false }));
    w.setKohyaFlag(false);
    const body = (await w.run(false)).body!;
    expect(body.tags).toEqual(['own-tag']);
    expect(body.metadata).toEqual({ retrainOf: SOURCE });
    expect(body).not.toHaveProperty('callbacks');

    const studio = createWorld(sourceRun());
    studio.setKohyaFlag(false);
    expect(await studio.run(false)).toMatchObject({
      outcome: 'skipped',
      reason: 'kohya-unavailable',
    });
  });

  it('refunds, confirms a zero net in every colour, submits once; a repeat returns the same retrain without refunding again', async () => {
    const w = createWorld(sourceRun());
    const first = await w.run(true);
    expect(first.outcome).toBe('retrained');
    expect(first.confirmedNetByColour).toEqual({ blue: 0, yellow: 0 });
    expect(credited(w).map((t) => [t.accountType, t.amount])).toEqual([
      ['blue', 300],
      ['yellow', 200],
    ]);

    w.advance(10 * 60_000);
    const second = await w.run(true);
    expect(second.outcome).toBe('already-retrained');
    const retrainId = first.retrain!.id;
    expect(retrainId).toMatch(new RegExp(`^${OWNER}-`));
    expect(second.retrain).toEqual({
      id: retrainId,
      status: 'unassigned',
      chargedByColour: { blue: 480 },
    });
    expect(w.calls.refund).toBe(1);
    expect(credited(w)).toHaveLength(2);
  });

  it('reports a retrain’s current status by reading it, never by submitting, and only for this source’s retrain', async () => {
    const w = createWorld(sourceRun());
    const retrainId = (await w.run(true)).retrain!.id;
    w.runs.get(retrainId)!.status = 'succeeded';
    const submits = w.calls.submit;

    expect(await w.run(false, retrainId)).toMatchObject({
      outcome: 'retrain-status',
      retrain: { id: retrainId, status: 'succeeded' },
    });
    // The source itself is a run of the owner's, but not this source's retrain.
    expect(await w.run(false, SOURCE)).toMatchObject({
      outcome: 'skipped',
      reason: 'retrain-not-found',
    });
    // The owner deleted the retrain: reported, and nothing is submitted in its place.
    w.runs.delete(retrainId);
    expect(await w.run(false, retrainId)).toMatchObject({
      outcome: 'skipped',
      reason: 'retrain-not-found',
    });
    expect(w.calls.submit).toBe(submits);
  });

  it('does not take the force-refunded flag as proof: a colour left owed is refunded again before the submit, or nothing is submitted', async () => {
    const w = createWorld(sourceRun());
    w.failColours.add('yellow');
    const resumed = await w.run(true);
    expect(resumed.outcome).toBe('retrained');
    expect(w.calls.refund).toBe(2);
    expect(
      credited(w)
        .map((t) => t.accountType)
        .sort()
    ).toEqual(['blue', 'yellow']);

    // An earlier call left it flagged with yellow still owed: this call refunds yellow, and only yellow.
    const flagged = createWorld(
      sourceRun({
        status: 'failed',
        forceRefunded: true,
        transactions: {
          list: [
            { type: 'debit', amount: 300, accountType: 'blue', id: 't1' },
            { type: 'debit', amount: 200, accountType: 'yellow', id: 't2' },
            { type: 'credit', amount: 300, accountType: 'blue' },
          ],
        },
      })
    );
    flagged.refundKeys.add(`refund-all-blue-${SOURCE}`);
    expect((await flagged.run(true)).outcome).toBe('retrained');
    expect(credited(flagged).map((t) => [t.accountType, t.amount])).toEqual([
      ['blue', 300],
      ['yellow', 200],
    ]);

    // A 5xx from /refund is tried again (each colour is keyed, so a repeat pays nothing twice).
    const flaky = createWorld(sourceRun());
    const refundOnce = flaky.deps.forceRefund;
    let failures = 1;
    flaky.deps.forceRefund = async (id) => (failures-- > 0 ? 503 : refundOnce(id));
    expect((await flaky.run(true)).outcome).toBe('retrained');
    expect(credited(flaky)).toHaveLength(2);

    const stuck = createWorld(sourceRun());
    stuck.deps.forceRefund = async (id) => {
      stuck.calls.refund++;
      const run = stuck.runs.get(id)!;
      run.forceRefunded = true;
      run.status = 'failed';
      return 204;
    };
    const result = await stuck.run(true);
    expect(result.outcome).toBe('refund-unconfirmed');
    expect(stuck.calls.refund).toBe(3);
    expect(stuck.calls.submit).toBe(0);
  });

  it('refund-only refunds the run and never quotes or submits a retrain', async () => {
    const w = createWorld(sourceRun());
    w.setAllowlist({ [SOURCE]: 'refund-only' });
    expect((await w.run(false)).outcome).toBe('would-refund');
    expect(w.calls.refund).toBe(0);
    expect((await w.run(true)).outcome).toBe('refunded');
    expect((await w.run(true)).outcome).toBe('already-refunded');
    expect(w.calls.refund).toBe(1);
    expect(w.calls.quote + w.calls.submit).toBe(0);
  });

  it('refuses before any money moves: not allowlisted, the allowlist unreadable, outside the window, after the hard stop, a quote above what was charged, mature images on Green', async () => {
    const notListed = createWorld(sourceRun());
    notListed.setAllowlist({});
    expect(await notListed.run(true)).toMatchObject({
      outcome: 'skipped',
      reason: 'not-allowlisted',
    });

    const down = createWorld(sourceRun());
    down.setAllowlistDown();
    await expect(down.run(true)).rejects.toThrow('sysRedis down');

    const late = createWorld(sourceRun({ createdAt: '2026-11-23T01:00:00Z' }));
    expect(await late.run(true)).toMatchObject({ outcome: 'skipped', reason: 'source-ineligible' });

    const expired = createWorld(sourceRun());
    expired.advance(RETRAIN_HARD_STOP.getTime() - NOW.getTime());
    expect(await expired.run(true)).toMatchObject({ outcome: 'skipped', reason: 'expired' });

    const over = createWorld(sourceRun(), { quote: 501 });
    expect(await over.run(true)).toMatchObject({ outcome: 'skipped', reason: 'quote-over' });

    const mature = createWorld(sourceRun({ currencies: ['blue', 'green'] }), {
      nsfw: { [BLOB(2)]: 'X' },
    });
    expect(await mature.run(true)).toMatchObject({ outcome: 'skipped', reason: 'mature-reprice' });

    for (const w of [notListed, down, late, expired, over, mature]) {
      expect(w.calls.refund + w.calls.submit).toBe(0);
    }
  });

  it.each([
    ['source-withheld', { withheld: true }],
    ['training-unavailable', { training: 'Training is currently disabled' }],
    ['trigger-word-refused', { triggerWord: 'This trigger word has been blocked.' }],
    ['license-not-accepted', { license: 'Accept the licence first.' }],
  ] as const)(
    'a refusing gate stops the retrain before any money moves: %s',
    async (reason, gate) => {
      const w = createWorld(sourceRun());
      Object.assign(w.refuse, gate);
      expect(await w.run(true)).toMatchObject({ outcome: 'skipped', reason });
      expect(w.calls.refund + w.calls.quote + w.calls.submit).toBe(0);
    }
  );

  it('applies the mature rule only to runs that may pay in Green, and refuses when it cannot read the dataset', async () => {
    const nsfw = { [BLOB(2)]: 'X' };
    expect((await createWorld(sourceRun(), { nsfw }).run(false)).outcome).toBe('would-retrain');

    const green = { currencies: ['blue', 'green'] } as Partial<Workflow>;
    const unreadable = createWorld(sourceRun(green), { nsfw: { [BLOB(1)]: null } });
    expect(await unreadable.run(true)).toMatchObject({
      outcome: 'skipped',
      reason: 'rating-unavailable',
    });

    const stamped = createWorld(
      sourceRun({ ...green, metadata: { name: 'My LoRA', matureCount: 3 } })
    );
    expect(await stamped.run(true)).toMatchObject({ outcome: 'skipped', reason: 'mature-reprice' });
    expect(unreadable.calls.refund + stamped.calls.refund).toBe(0);
  });

  it.each([
    ['an estimate (no charge)', { transactions: { list: [] } }],
    ['another account’s run', { id: '9999-20261122100000000-zz99' }],
    ['another externalId', { externalId: `${OWNER}-retrain-other` }],
  ])(
    'refuses a submit answer that is not a charged run of the owner’s under this externalId: %s',
    async (_, override) => {
      const w = createWorld(sourceRun());
      const owner = w.deps.ownerOrchestrator;
      w.deps.ownerOrchestrator = async (userId) => {
        const orch = (await owner(userId))!;
        return {
          ...orch,
          submit: async (body) => {
            const answer = await orch.submit(body);
            return { ...answer, workflow: { ...answer.workflow!, ...override } as Workflow };
          },
        };
      };
      expect(await w.run(true)).toMatchObject({ outcome: 'bad-submit-result' });
    }
  );
});
