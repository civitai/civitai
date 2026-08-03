import type * as StepsModule from '~/server/services/blocks/steps';
import type { Workflow } from '@civitai/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

/**
 * Coverage for the `'textOutput'` moderation posture — the OUTPUT-phase scan
 * that stands between a registered step's generated text and the block.
 *
 * 🔴 WHAT THIS SUITE HAS TO PROVE, and why a lesser test would prove nothing:
 *
 *  1. THE HANDLER IS NOT INERT. A test that the posture is DECLARED, or that a
 *     handler EXISTS, is worthless — the failure this posture exists to prevent
 *     is precisely a declared, registered, load-time-gated handler that runs and
 *     scans nothing. So the load-bearing test drives the REAL read-path function
 *     (`attachModeratedStepTextOutputs`) over a REAL orchestrator-shaped workflow
 *     and asserts the flagged text is ABSENT from the snapshot the block gets.
 *
 *  2. …AND IT IS PAIRED WITH A POSITIVE CONTROL. "the text is absent" is exactly
 *     what a harness wired to nothing also reports. Every withhold assertion
 *     below has a sibling that changes ONLY the scan verdict and asserts the
 *     text IS published — so the absence is a fact about the policy, not about
 *     the fixture.
 *
 *  3. IT FAILS CLOSED. Scanner throw, scanner timeout, submit returning nothing,
 *     a workflow with no verdict — every one withholds.
 *
 *  4. THE POLICY TIERS ARE REAL. Seven labels withhold on any host; three
 *     withhold only when the token's ceiling is SFW; five are scanned and NOT
 *     acted on. Each tier is asserted in both directions.
 *
 *  5. IT READS `triggeredLabels` + per-label results, NEVER `blocked`. A text
 *     scoring 0.99 on `Explicit` comes back `blocked: false`, because that
 *     label's ACTION is `Scan` — measured against the deployed scanner. A policy
 *     keyed on `blocked` would release it.
 */

const { mockCreateXGuardModerationRequest, mockLogToAxiom } = vi.hoisted(() => ({
  mockCreateXGuardModerationRequest: vi.fn(),
  mockLogToAxiom: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: mockCreateXGuardModerationRequest,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));

// 🔴 THE REGISTRY IS OVERRIDDEN FOR `getStepByOrchestratorType` ONLY, and it is
// the minimum needed to test the read path today: the shipped registry has no
// `'textOutput'` entry yet (registering `chatCompletion` is the follow-up), so
// without an injected entry the loop below would have nothing to dispatch on and
// this whole suite would be the vacuous "it is declared" test it exists to avoid.
// Every other export — `posturePhaseRequirements`,
// `isModerationPostureImplemented`, the load-time asserts — is the REAL one, so
// the module-load phase-table check still runs against the shipped table.
const registryOverride = new Map<string, unknown>();
vi.mock('~/server/services/blocks/steps', async (importOriginal) => {
  const actual = await importOriginal<StepsModule>();
  return {
    ...actual,
    getStepByOrchestratorType: (orchestratorType: string) =>
      registryOverride.get(orchestratorType) ?? actual.getStepByOrchestratorType(orchestratorType),
  };
});

import {
  assertStepInvariants,
  mediaFromBlobs,
  type AnyBlockStep,
  type BlockStep,
} from '~/server/services/blocks/steps';
import type { OrchestratorBlobLike } from '~/server/services/blocks/steps/output';
import {
  attachModeratedStepTextOutputs,
  runStepOutputModeration,
} from '~/server/services/blocks/steps/moderation';
import {
  ALWAYS_WITHHOLD_LABELS,
  decideTextOutputVerdict,
  NOT_ACTED_ON_LABELS,
  screenGeneratedText,
  SFW_ONLY_WITHHOLD_LABELS,
  TEXT_OUTPUT_SCAN_LABELS,
  TEXT_OUTPUT_WITHHELD_MESSAGE,
} from '~/server/services/blocks/steps/text-output-moderation';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const GENERATED_TEXT = 'the model wrote this sentence';
const CHAT_TYPE = 'fixtureChat';

type FixtureParams = { value: number };
const fixtureParamSchema = z.object({ value: z.number().int().min(1).max(10) }).strict();

/** An orchestrator-shaped COMPLETED chat step, as it arrives on a workflow. */
function chatStep(content = GENERATED_TEXT) {
  return {
    $type: CHAT_TYPE,
    output: { choices: [{ message: { content } }] },
  };
}

/**
 * A registry entry declaring `'textOutput'`. Shaped so the REAL
 * `assertStepInvariants` accepts it (asserted below) — a fixture the registry
 * would reject would make every read-path test here a statement about an entry
 * that could never exist.
 */
function makeTextStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
  const base = {
    id: 'fixture-chat',
    orchestratorType: CHAT_TYPE,
    billingMode: 'prepaidFixed',
    moderationPosture: 'textOutput',
    resourcePolicy: { kind: 'none' },
    paramSchema: fixtureParamSchema,
    variants: ['default'],
    resolveVariant: () => 'default',
    canonicalParamsFor: (): FixtureParams => ({ value: 1 }),
    priceForVariant: () => 7,
    estimateBuzz: () => 7,
    buildStep: (p: FixtureParams) => ({ $type: CHAT_TYPE, input: { value: p.value } }),
    extractOutput: (step: unknown) =>
      mediaFromBlobs(
        (step as { output?: { blob?: OrchestratorBlobLike | null } } | null | undefined)?.output
          ?.blob
      ),
    canonicalOutputFor: (): unknown => ({
      ...chatStep(),
      output: {
        ...chatStep().output,
        blob: { url: 'https://blobs.example/f.webp', available: true },
      },
    }),
    extractText: (step: unknown) =>
      (
        (step as { output?: { choices?: Array<{ message?: { content?: string } }> } })?.output
          ?.choices ?? []
      )
        .map((c) => c.message?.content ?? '')
        .filter((t) => t.length > 0),
  } satisfies BlockStep<FixtureParams>;
  return { ...base, ...overrides } as AnyBlockStep;
}

/** A workflow carrying one completed text step. */
function workflowWith(...steps: unknown[]): Workflow {
  return {
    id: 'wf-1',
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00Z',
    steps,
  } as unknown as Workflow;
}

/** A scan output where the named labels triggered. */
function scanOutput(triggered: string[], scores: Record<string, number> = {}) {
  return {
    blocked: false,
    triggeredLabels: triggered,
    results: TEXT_OUTPUT_SCAN_LABELS.map((label) => ({
      label,
      action: 'Scan',
      threshold: 0.5,
      score: scores[label] ?? (triggered.includes(label) ? 0.97 : 0.04),
      triggered: triggered.includes(label),
      topToken: '',
      field: 'text',
      modelReason: '',
    })),
  };
}

/** Make the mocked scanner return the given step output. */
function scannerReturns(output: unknown) {
  mockCreateXGuardModerationRequest.mockResolvedValue({
    id: 'scan-wf',
    status: 'succeeded',
    steps: [{ $type: 'xGuardModeration', output }],
  });
}

const CTX = { userId: 42, isGreen: false, appId: 'app-1', appBlockId: 'blk-1' };

beforeEach(() => {
  mockCreateXGuardModerationRequest.mockReset();
  mockLogToAxiom.mockReset();
  mockLogToAxiom.mockResolvedValue(undefined);
  registryOverride.clear();
  registryOverride.set(CHAT_TYPE, makeTextStep());
});

// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the fixture is a REGISTRABLE entry', () => {
  it('the real load-time invariants accept it', () => {
    // 🔴 THE CONTROL FOR THE WHOLE SUITE. If the registry would reject this
    // shape, every read-path assertion below would be about an entry that can
    // never exist, and the suite would prove nothing about anything shippable.
    expect(() => assertStepInvariants('fixture-chat', makeTextStep())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — 🔴 THE HANDLER IS NOT INERT (read-path, end to end)', () => {
  it('WITHHOLDS flagged text — the block never sees it', async () => {
    scannerReturns(scanOutput(['Young']));

    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );

    // The assertion that matters. Not "a handler ran", not "a mock was called":
    // the generated string is absent from the object the block receives.
    expect(snapshot.textOutputs).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(GENERATED_TEXT);
    expect(snapshot.textOutputWithheld).toEqual({ reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
  });

  it('🔴 POSITIVE CONTROL — the SAME path publishes the text on a clean scan', async () => {
    // Without this, "textOutputs is undefined" is indistinguishable from a
    // harness wired to nothing: a `attachModeratedStepTextOutputs` that always
    // returned the snapshot untouched would pass the test above and fail this
    // one. ONLY the scan verdict differs between the two.
    scannerReturns(scanOutput([]));

    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );

    expect(snapshot.textOutputs).toEqual([GENERATED_TEXT]);
    expect(snapshot.textOutputWithheld).toBeUndefined();
  });

  it('the scan is handed the ACTUAL generated text, and all 15 labels', async () => {
    scannerReturns(scanOutput([]));
    await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep('a very specific generated sentence')),
      CTX
    );
    const arg = mockCreateXGuardModerationRequest.mock.calls[0][0];
    expect(arg.mode).toBe('text');
    expect(arg.content).toBe('a very specific generated sentence');
    expect(arg.labels).toEqual([...TEXT_OUTPUT_SCAN_LABELS]);
    expect(arg.labels).toHaveLength(15);
  });

  it('passes callbackUrl: null and NO entity fields (no EntityModeration row)', async () => {
    // 🔴 `EntityModeration` does not exist in the production database, and
    // OMITTING `callbackUrl` (rather than passing null) makes the request
    // builder default to the text-moderation webhook, which drives the scanner
    // audit write. Both are runtime failures on this path, and neither is
    // visible in a test that only asserts the verdict.
    scannerReturns(scanOutput([]));
    await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    const arg = mockCreateXGuardModerationRequest.mock.calls[0][0];
    expect(arg).toHaveProperty('callbackUrl', null);
    expect(arg.entityType).toBeUndefined();
    expect(arg.entityId).toBeUndefined();
  });

  it('a caller cannot smuggle text past the scan by pre-populating the snapshot', async () => {
    // The field's guarantee is "everything here was scanned". Merging over an
    // incoming value rather than stripping it would leave a second, unscanned
    // producer — which is the whole property this function exists to hold.
    scannerReturns(scanOutput(['Young']));
    const snapshot = await attachModeratedStepTextOutputs(
      {
        workflowId: 'wf-1',
        status: 'succeeded' as const,
        textOutputs: ['smuggled unscanned text'],
      },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('smuggled');
  });

  it('leaves every other snapshot field byte-identical', async () => {
    scannerReturns(scanOutput([]));
    const input = {
      workflowId: 'wf-1',
      status: 'succeeded' as const,
      cost: { total: 12 },
      imageUrls: ['https://blobs.example/a.webp'],
    };
    const snapshot = await attachModeratedStepTextOutputs(input, workflowWith(chatStep()), CTX);
    expect(snapshot.workflowId).toBe('wf-1');
    expect(snapshot.cost).toEqual({ total: 12 });
    expect(snapshot.imageUrls).toEqual(['https://blobs.example/a.webp']);
  });

  it('does not scan, and adds no field, for a workflow with no registered step', async () => {
    // The pre-existing txt2img / customComfy paths must be untouched: no
    // scanner call, no new keys.
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith({ $type: 'textToImage', output: { images: [] } }),
      CTX
    );
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
    expect(snapshot).toEqual({ workflowId: 'wf-1', status: 'succeeded' });
  });

  it('publishes the clean step and withholds the flagged one (per-step, not all-or-nothing)', async () => {
    const cleanType = 'fixtureChatB';
    registryOverride.set(
      cleanType,
      makeTextStep({ id: 'fixture-chat-b', orchestratorType: cleanType } as Partial<AnyBlockStep>)
    );
    mockCreateXGuardModerationRequest
      .mockResolvedValueOnce({
        steps: [{ $type: 'xGuardModeration', output: scanOutput(['Bestiality']) }],
      })
      .mockResolvedValueOnce({
        steps: [{ $type: 'xGuardModeration', output: scanOutput([]) }],
      });

    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(
        { ...chatStep('flagged piece'), $type: CHAT_TYPE },
        { ...chatStep('clean piece'), $type: cleanType }
      ),
      CTX
    );

    expect(snapshot.textOutputs).toEqual(['clean piece']);
    expect(JSON.stringify(snapshot)).not.toContain('flagged piece');
    expect(snapshot.textOutputWithheld).toEqual({ reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — 🔴 FAILS CLOSED', () => {
  it.each([
    [
      'the scanner THROWS',
      () => mockCreateXGuardModerationRequest.mockRejectedValue(new Error('orchestrator 503')),
    ],
    [
      'the submit returns nothing (undefined workflow)',
      () => mockCreateXGuardModerationRequest.mockResolvedValue(undefined),
    ],
    [
      'the workflow carries no xGuardModeration step',
      () => mockCreateXGuardModerationRequest.mockResolvedValue({ id: 'x', steps: [] }),
    ],
    [
      'the scan step has no output (wait elapsed mid-scan)',
      () =>
        mockCreateXGuardModerationRequest.mockResolvedValue({
          id: 'x',
          status: 'processing',
          steps: [{ $type: 'xGuardModeration' }],
        }),
    ],
  ])('WITHHOLDS when %s', async (_label, arrange) => {
    arrange();
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(GENERATED_TEXT);
    expect(snapshot.textOutputWithheld).toEqual({ reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
  });

  it('🔴 this is the OPPOSITE of auditPromptServer, and it must stay that way', async () => {
    // `auditPromptServer` catches an `extModeration` outage and lets the prompt
    // THROUGH — the user authored that text. This text is model output nobody has
    // seen. A future "make the two consistent" refactor would silently ship
    // unscanned generated output; this test is what stops it.
    mockCreateXGuardModerationRequest.mockRejectedValue(new Error('extModeration down'));
    const result = await runStepOutputModeration({
      step: makeTextStep(),
      orchestratorStep: chatStep(),
      ...CTX,
    });
    expect(result.released).toBe(false);
  });

  it('WITHHOLDS when extractText returns a non-array at request time', async () => {
    registryOverride.set(
      CHAT_TYPE,
      makeTextStep({ extractText: () => 'not an array' } as unknown as Partial<AnyBlockStep>)
    );
    scannerReturns(scanOutput([]));
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toBeUndefined();
    expect(snapshot.textOutputWithheld).toBeDefined();
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('WITHHOLDS when extractText returns a non-string entry', async () => {
    registryOverride.set(
      CHAT_TYPE,
      makeTextStep({ extractText: () => ['ok', 42] } as unknown as Partial<AnyBlockStep>)
    );
    scannerReturns(scanOutput([]));
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toBeUndefined();
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('releases an EMPTY result without scanning when there is no generated text', async () => {
    // The mirror image of the input-side rule, and deliberately NOT a rejection:
    // an empty extraction publishes nothing, so no unscanned text escapes. (On
    // the INPUT side an empty prompt IS rejected — there, "scan nothing" means
    // the submit proceeds unaudited.)
    registryOverride.set(CHAT_TYPE, makeTextStep({ extractText: () => ['  ', ''] }));
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
    expect(snapshot.textOutputs).toBeUndefined();
    expect(snapshot.textOutputWithheld).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the approved label policy', () => {
  it('the three tiers PARTITION the scanned labels — none silently drops out', () => {
    const acted = [...ALWAYS_WITHHOLD_LABELS, ...SFW_ONLY_WITHHOLD_LABELS];
    expect(ALWAYS_WITHHOLD_LABELS).toHaveLength(7);
    expect(SFW_ONLY_WITHHOLD_LABELS).toHaveLength(3);
    expect(NOT_ACTED_ON_LABELS).toHaveLength(5);
    expect([...acted, ...NOT_ACTED_ON_LABELS].sort()).toEqual([...TEXT_OUTPUT_SCAN_LABELS].sort());
    // No label may appear in two tiers.
    expect(new Set([...acted, ...NOT_ACTED_ON_LABELS]).size).toBe(15);
  });

  it.each(ALWAYS_WITHHOLD_LABELS.map((l) => [l]))(
    "'%s' withholds on a MATURE-allowed host too",
    (label) => {
      // The host-independent tier. `isGreen: false` == the ceiling permits mature
      // content, and these must still withhold.
      const verdict = decideTextOutputVerdict(scanOutput([label]), { isGreen: false });
      expect(verdict.released).toBe(false);
      expect(verdict.withholdingLabels).toEqual([label]);
    }
  );

  it.each(SFW_ONLY_WITHHOLD_LABELS.map((l) => [l]))(
    "'%s' withholds on SFW and RELEASES on a mature-allowed host",
    (label) => {
      // 🔴 BOTH DIRECTIONS ON THE SAME LABEL. A policy that hardcoded `isGreen`
      // either way passes exactly one of these two assertions and fails the
      // other; neither can pass both.
      expect(decideTextOutputVerdict(scanOutput([label]), { isGreen: true }).released).toBe(false);
      expect(decideTextOutputVerdict(scanOutput([label]), { isGreen: false }).released).toBe(true);
    }
  );

  it.each(NOT_ACTED_ON_LABELS.map((l) => [l]))(
    "'%s' is scanned and reported but never withholds, on EITHER host",
    (label) => {
      for (const isGreen of [true, false]) {
        const verdict = decideTextOutputVerdict(scanOutput([label]), { isGreen });
        expect(verdict.released).toBe(true);
        // …and it is still REPORTED. Dropping these from the scan would lose the
        // telemetry the 15-label choice was made for.
        expect(verdict.triggeredLabels).toContain(label);
      }
    }
  );

  it('releases a completely benign scan (the negative control for every case above)', () => {
    const verdict = decideTextOutputVerdict(scanOutput([]), { isGreen: true });
    expect(verdict.released).toBe(true);
    expect(verdict.withholdingLabels).toEqual([]);
    expect(verdict.triggeredLabels).toEqual([]);
  });

  it('🔴 IGNORES `blocked` — a 0.99 Explicit comes back blocked:false', () => {
    // Measured against the deployed scanner: the `Explicit` label's ACTION is
    // `Scan`, so `blocked` stays false however high the score. A policy keyed on
    // `blocked` releases this. On a SFW ceiling it must not.
    const output = { ...scanOutput(['Explicit'], { Explicit: 0.99 }), blocked: false };
    expect(decideTextOutputVerdict(output, { isGreen: true }).released).toBe(false);
  });

  it('🔴 IGNORES `blocked` in the other direction too', () => {
    // The complement: `blocked: true` with only a non-actioned label triggering
    // must NOT withhold. A policy that ORed `blocked` in would fail this.
    const output = { ...scanOutput(['Celebrity']), blocked: true };
    expect(decideTextOutputVerdict(output, { isGreen: true }).released).toBe(true);
  });

  it('UNIONS the two trigger signals — either one alone withholds', () => {
    // If `triggeredLabels` and `results[].triggered` ever disagree, union
    // withholds and intersection releases. Union is the fail-closed direction.
    const fromArrayOnly = { triggeredLabels: ['Young'], results: [] };
    const fromResultsOnly = {
      triggeredLabels: [],
      results: [{ label: 'Young', score: 0.98, triggered: true }],
    };
    expect(decideTextOutputVerdict(fromArrayOnly, { isGreen: false }).released).toBe(false);
    expect(decideTextOutputVerdict(fromResultsOnly, { isGreen: false }).released).toBe(false);
  });

  it('matches labels CASE-INSENSITIVELY', () => {
    // The label strings are orchestrator-side config, not a code-owned enum —
    // the debug endpoint's own docs show `"young"` and `"Young"` in one example.
    // An exact-match policy would match nothing and release everything.
    for (const label of ['young', 'YOUNG', ' Young ']) {
      expect(
        decideTextOutputVerdict({ triggeredLabels: [label], results: [] }, { isGreen: false })
          .released
      ).toBe(false);
    }
  });

  it('reports per-label SCORES for the trigger log', () => {
    const verdict = decideTextOutputVerdict(scanOutput(['Young'], { Young: 0.96 }), {
      isGreen: false,
    });
    expect(verdict.scores.Young).toBe(0.96);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['garbage field types', { triggeredLabels: 'Young', results: 'nope' }],
  ])('treats %s as no triggers rather than throwing', (_label, output) => {
    // The DECISION is total. Fail-closed on a missing verdict is
    // `screenGeneratedText`'s job (asserted above) — this function's contract is
    // "never throw on a read path", and a throw here would become a 500 on poll.
    const verdict = decideTextOutputVerdict(output as never, { isGreen: true });
    expect(verdict.released).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the trigger log', () => {
  it('logs userId, appId, appBlockId, model, labels and scores on a withhold', async () => {
    scannerReturns(scanOutput(['Young'], { Young: 0.96 }));
    await screenGeneratedText({
      texts: [GENERATED_TEXT],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      appBlockId: 'blk-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      name: 'block-step-text-output-moderation',
      stage: 'withheld',
      userId: 42,
      appId: 'app-1',
      appBlockId: 'blk-1',
      model: CHAT_TYPE,
      withholdingLabels: ['Young'],
    });
    expect(mockLogToAxiom.mock.calls[0][0].scores).toMatchObject({ Young: 0.96 });
  });

  it('🔴 NEVER logs the withheld text itself', async () => {
    scannerReturns(scanOutput(['Young']));
    await screenGeneratedText({
      texts: [GENERATED_TEXT],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(JSON.stringify(mockLogToAxiom.mock.calls)).not.toContain(GENERATED_TEXT);
  });

  it('does not log on a clean release (the log is a trigger signal, not a trace)', async () => {
    scannerReturns(scanOutput([]));
    await screenGeneratedText({
      texts: [GENERATED_TEXT],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('a logging failure does not turn a decided verdict into a throw', async () => {
    mockLogToAxiom.mockRejectedValue(new Error('axiom down'));
    scannerReturns(scanOutput(['Young']));
    await expect(
      screenGeneratedText({
        texts: [GENERATED_TEXT],
        userId: 42,
        isGreen: false,
        appId: 'app-1',
        stepId: 'fixture-chat',
        model: CHAT_TYPE,
      })
    ).resolves.toMatchObject({ released: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the OUTPUT dispatch over the posture table', () => {
  it.each([['none'], ['promptAudit']])(
    "the '%s' posture releases an EMPTY list and never scans",
    async (posture) => {
      const result = await runStepOutputModeration({
        step: makeTextStep({
          moderationPosture: posture,
          extractText: undefined,
        } as unknown as Partial<AnyBlockStep>),
        orchestratorStep: chatStep(),
        ...CTX,
      });
      expect(result).toEqual({ released: true, texts: [] });
      expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
    }
  );

  it.each([['toString'], ['constructor'], ['valueOf'], ['__proto__']])(
    "FAILS CLOSED on the Object.prototype key '%s'",
    async (posture) => {
      // The same prototype-key hazard the submit dispatch documents: on a plain
      // object literal `handlers['toString']` is TRUTHY, and a truthy non-handler
      // on a READ path would have to be called or coerced. The null prototype
      // makes it `undefined`; the guard then withholds.
      const result = await runStepOutputModeration({
        step: makeTextStep({
          moderationPosture: posture,
          extractText: undefined,
        } as unknown as Partial<AnyBlockStep>),
        orchestratorStep: chatStep(),
        ...CTX,
      });
      expect(result).toEqual({ released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
    }
  );
});
