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
// 🔴 NOT OPTIONAL, AND NOT COSMETIC — WITHOUT IT THIS FILE LIES VIA ITS EXIT
// CODE. `workflow.service` (imported below for the two real read-path
// projections) imports `~/server/db/client` at module scope, which instantiates
// a real Prisma client. Nothing in this suite queries it, but the instantiation
// rejects (`PrismaClientInitializationError`), vitest reports the unhandled
// rejection as a file-level "Errors: 1", and the process EXITS 1 — while every
// assertion passes and the summary reads `76 passed (76)`.
//
// That combination is the exact harness trap this repo has been bitten by: a
// mutation sweep that reads `rc` sees a non-zero exit for the CONTROL and for
// every mutant alike, and reports 100% of mutants killed while testing nothing.
// The sibling suites all mock this module for the same reason. Read the
// `Tests N failed | M passed` line, and keep this mock so `rc` agrees with it.
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
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
  type AnyBlockStep,
  type BlockStep,
} from '~/server/services/blocks/steps';
import {
  attachModeratedStepTextOutputs,
  runStepOutputModeration,
} from '~/server/services/blocks/steps/moderation';
// 🔴 The two REAL read-path projections, imported so the media-channel tests
// below drive them rather than re-describing what they do. The registry mock
// above applies to them too: `workflow.service` imports
// `getStepByOrchestratorType` from the same module id.
import {
  projectAppWorkflow,
  snapshotFromWorkflow,
} from '~/server/services/blocks/workflow.service';
import {
  ALWAYS_WITHHOLD_LABELS,
  decideTextOutputVerdict,
  MAX_SCANNED_CONTENT_CHARS,
  missingRequestedLabels,
  NOT_ACTED_ON_LABELS,
  screenGeneratedText,
  SFW_ONLY_WITHHOLD_LABELS,
  TEXT_OUTPUT_SCAN_LABELS,
  TEXT_OUTPUT_WITHHELD_MESSAGE,
  VERDICT_CACHE_MAX_ENTRIES,
  __clearTextOutputVerdictCacheForTests,
} from '~/server/services/blocks/steps/text-output-moderation';
// 🔴 A NAMESPACE IMPORT, ON PURPOSE, AND ONLY FOR `erroredRequestedLabels`.
// A NAMED import of a symbol the module does not export is a LINK-TIME failure
// under vitest's ESM transform: the whole file fails to COLLECT and reports
// `Tests no tests`, which reads as "nothing to see" rather than as a failure.
// That would destroy the red-at-base measurement these cases exist to produce —
// nobody could re-run this file against the pre-fix commit and see the
// erroring-label cases go red, because none of the other 81 would run either.
// Through the namespace the missing export is merely `undefined`, so each case
// fails on its own assertion and the rest of the suite still executes. Keep it.
import * as TextOutputModeration from '~/server/services/blocks/steps/text-output-moderation';

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
    // 🔴 NO `extractOutput`, AND NO FABRICATED BLOB IN `canonicalOutputFor`.
    // Both used to be here, and they were the audit's exhibit: `extractOutput`
    // was unconditionally required and clause 8 unconditionally demanded ≥1
    // media item with a url, so the only way to write a `'textOutput'` fixture
    // was to invent an image a real `chatCompletion` step never returns. A real
    // adopter reaching for the same workaround would put the model's REPLY in
    // that url — which reaches `snapshot.imageUrls` without meeting the scan.
    // The registry now forbids the field on a text entry outright.
    canonicalOutputFor: (): unknown => chatStep(),
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

/**
 * `requestedLabels` for a verdict test.
 *
 * 🔴 TWO VALUES ON PURPOSE, and picking the wrong one makes a test pass for the
 * wrong reason. `decideTextOutputVerdict` withholds when a REQUESTED label has
 * no `results[]` entry (the rename fail-open the generated client documents), so
 * a POLICY test must ask only for labels its fixture actually answered — else
 * every assertion below would read `released: false` from label drift and the
 * tier logic would never be exercised at all.
 *   ALL  — with a `scanOutput(...)` fixture, which emits all 15 results.
 *   NONE — with a hand-built minimal fixture (`{ triggeredLabels, results: [] }`),
 *          where the drift check is deliberately vacuous.
 * The drift guard gets its own describe block, with both controls.
 */
const ALL = TEXT_OUTPUT_SCAN_LABELS;
const NONE: readonly string[] = [];

beforeEach(() => {
  mockCreateXGuardModerationRequest.mockReset();
  mockLogToAxiom.mockReset();
  mockLogToAxiom.mockResolvedValue(undefined);
  // 🔴 THE VERDICT MEMO IS MODULE-LIFETIME AND KEYED ON THE CONTENT. Nearly
  // every case here scans the SAME `GENERATED_TEXT` and varies only the scanner
  // response, which is precisely what the memo collapses — without this reset a
  // withhold would be replayed for the next test's positive control and the pair
  // would stop discriminating anything.
  __clearTextOutputVerdictCacheForTests();
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
      const verdict = decideTextOutputVerdict(scanOutput([label]), {
        isGreen: false,
        requestedLabels: ALL,
      });
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
      expect(
        decideTextOutputVerdict(scanOutput([label]), { isGreen: true, requestedLabels: ALL })
          .released
      ).toBe(false);
      expect(
        decideTextOutputVerdict(scanOutput([label]), { isGreen: false, requestedLabels: ALL })
          .released
      ).toBe(true);
    }
  );

  it.each(NOT_ACTED_ON_LABELS.map((l) => [l]))(
    "'%s' is scanned and reported but never withholds, on EITHER host",
    (label) => {
      for (const isGreen of [true, false]) {
        const verdict = decideTextOutputVerdict(scanOutput([label]), {
          isGreen,
          requestedLabels: ALL,
        });
        expect(verdict.released).toBe(true);
        // …and it is still REPORTED. Dropping these from the scan would lose the
        // telemetry the 15-label choice was made for.
        expect(verdict.triggeredLabels).toContain(label);
      }
    }
  );

  it('releases a completely benign scan (the negative control for every case above)', () => {
    const verdict = decideTextOutputVerdict(scanOutput([]), {
      isGreen: true,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(true);
    expect(verdict.withholdingLabels).toEqual([]);
    expect(verdict.triggeredLabels).toEqual([]);
  });

  it('🔴 IGNORES `blocked` — a 0.99 Explicit comes back blocked:false', () => {
    // Measured against the deployed scanner: the `Explicit` label's ACTION is
    // `Scan`, so `blocked` stays false however high the score. A policy keyed on
    // `blocked` releases this. On a SFW ceiling it must not.
    const output = { ...scanOutput(['Explicit'], { Explicit: 0.99 }), blocked: false };
    expect(decideTextOutputVerdict(output, { isGreen: true, requestedLabels: ALL }).released).toBe(
      false
    );
  });

  it('🔴 IGNORES `blocked` in the other direction too', () => {
    // The complement: `blocked: true` with only a non-actioned label triggering
    // must NOT withhold. A policy that ORed `blocked` in would fail this.
    const output = { ...scanOutput(['Celebrity']), blocked: true };
    expect(decideTextOutputVerdict(output, { isGreen: true, requestedLabels: ALL }).released).toBe(
      true
    );
  });

  it('UNIONS the two trigger signals — either one alone withholds', () => {
    // If `triggeredLabels` and `results[].triggered` ever disagree, union
    // withholds and intersection releases. Union is the fail-closed direction.
    const fromArrayOnly = { triggeredLabels: ['Young'], results: [] };
    const fromResultsOnly = {
      triggeredLabels: [],
      results: [{ label: 'Young', score: 0.98, triggered: true }],
    };
    expect(
      decideTextOutputVerdict(fromArrayOnly, { isGreen: false, requestedLabels: NONE }).released
    ).toBe(false);
    expect(
      decideTextOutputVerdict(fromResultsOnly, { isGreen: false, requestedLabels: NONE }).released
    ).toBe(false);
  });

  it('matches labels CASE-INSENSITIVELY', () => {
    // The label strings are orchestrator-side config, not a code-owned enum —
    // the debug endpoint's own docs show `"young"` and `"Young"` in one example.
    // An exact-match policy would match nothing and release everything.
    for (const label of ['young', 'YOUNG', ' Young ']) {
      expect(
        decideTextOutputVerdict(
          { triggeredLabels: [label], results: [] },
          {
            isGreen: false,
            requestedLabels: NONE,
          }
        ).released
      ).toBe(false);
    }
  });

  it('reports per-label SCORES for the trigger log', () => {
    const verdict = decideTextOutputVerdict(scanOutput(['Young'], { Young: 0.96 }), {
      isGreen: false,
      requestedLabels: ALL,
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
    const verdict = decideTextOutputVerdict(output as never, {
      isGreen: true,
      requestedLabels: NONE,
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE MEDIA CHANNEL — a text step must reach NEITHER read surface through it.
//
// `StepOutputMedia.url` is a bare string that nothing validates as a url, and it
// flows to `snapshot.imageUrls` and `AppWorkflow.images[].url` WITHOUT passing
// through `attachModeratedStepTextOutputs`. Before the media-XOR-text fix,
// `extractOutput` was unconditionally required of every entry — so an honest
// `chatCompletion` + `'textOutput'` entry could not register at all, and the
// workaround it pushed an author toward published the model's reply as a "url"
// with every moderation gate green.
//
// The registry now rejects that declaration (clause 8-ii) and the type forbids
// writing it (`TextOutputSurface.extractOutput?: never`). These tests cover the
// THIRD layer: the read path itself keys on the POSTURE, so an extractor that
// arrived through a cast still contributes nothing.
// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the media channel is closed at the READ path too', () => {
  const PROSE = 'Sure — here is exactly how you would do that. Step one, ';

  /** A text-posture entry with a media extractor forced on by a cast. */
  function smugglingStep() {
    return makeTextStep({
      extractOutput: () => [{ url: PROSE, width: null, height: null, nsfwLevel: null }],
    } as unknown as Partial<AnyBlockStep>);
  }

  /** The same extractor under a MEDIA posture — the positive control. */
  function honestMediaStep() {
    return makeTextStep({
      moderationPosture: 'none',
      extractText: undefined,
      extractOutput: () => [
        { url: 'https://blobs.example/real.webp', width: 4, height: 5, nsfwLevel: null },
      ],
    } as unknown as Partial<AnyBlockStep>);
  }

  it('snapshotFromWorkflow.imageUrls carries NOTHING from a text-posture step', () => {
    registryOverride.set(CHAT_TYPE, smugglingStep());
    const snap = snapshotFromWorkflow(workflowWith(chatStep()));
    expect(snap.imageUrls).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain(PROSE);
  });

  it('projectAppWorkflow.images carries NOTHING from a text-posture step', () => {
    // 🔴 This surface matters MORE: `queryAppWorkflows` / `cancelAppWorkflow`
    // return `AppWorkflow` UNWRAPPED — there is no scan in front of it at all.
    registryOverride.set(CHAT_TYPE, smugglingStep());
    const projected = projectAppWorkflow(workflowWith(chatStep()));
    expect(projected.images).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain(PROSE);
  });

  it('🔴 POSITIVE CONTROL — the IDENTICAL extractor under a media posture DOES reach both surfaces', () => {
    // Without this, "images is empty" is exactly what a harness wired to nothing
    // reports, and a `snapshotFromWorkflow` that had simply stopped consulting
    // the registry would pass both tests above. ONLY `moderationPosture` (and
    // the extractor's return url) differs.
    registryOverride.set(CHAT_TYPE, honestMediaStep());
    expect(snapshotFromWorkflow(workflowWith(chatStep())).imageUrls).toEqual([
      'https://blobs.example/real.webp',
    ]);
    expect(projectAppWorkflow(workflowWith(chatStep())).images).toEqual([
      { url: 'https://blobs.example/real.webp', width: 4, height: 5, nsfwLevel: null },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE CONTENT CAP — bounded, and FAILING CLOSED above the bound.
// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the content-length cap', () => {
  function textOfLength(n: number) {
    return 'x'.repeat(n);
  }

  it('the cap is 50,000 characters — pinned LITERALLY, not derived', () => {
    // 🔴 A VALUE PIN, and it is the assertion that a cap RAISE has to walk past.
    // Every other test in this block derives its input length FROM the constant,
    // so all of them move with it — raising the cap to something effectively
    // unbounded would leave them measuring the new number rather than failing.
    // The cost/latency arithmetic behind this figure (~5 chunks × 15 labels ≈ 75
    // scan units, ~12.5k tokens) is in the constant's own doc comment; changing
    // it is a policy decision that must change this line too.
    expect(MAX_SCANNED_CONTENT_CHARS).toBe(50_000);
  });

  it('WITHHOLDS over the cap, WITHOUT calling the scanner', async () => {
    const result = await screenGeneratedText({
      texts: [textOfLength(MAX_SCANNED_CONTENT_CHARS + 1)],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(result).toEqual({ released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
    // 🔴 Fails closed AND fails CHEAP — the point of the cap is that an
    // over-large payload costs no scan units, so this assertion is the cap
    // rather than merely the withhold.
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('🔴 POSITIVE CONTROL — content EXACTLY at the cap is scanned and released', async () => {
    // One character apart from the case above. Without this, "withheld" is
    // indistinguishable from a `screenGeneratedText` that withholds everything,
    // and a cap of 0 would pass the previous test.
    scannerReturns(scanOutput([]));
    const texts = [textOfLength(MAX_SCANNED_CONTENT_CHARS)];
    const result = await screenGeneratedText({
      texts,
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(result).toEqual({ released: true, texts });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(1);
  });

  it('the cap applies to the JOINED content, not to any one piece', async () => {
    // The scan is one call over `texts.join('\n\n')`, so N pieces each under the
    // cap can still exceed it together. A per-piece check would let exactly the
    // payload the cap exists to bound straight through.
    const half = Math.ceil(MAX_SCANNED_CONTENT_CHARS / 2);
    const result = await screenGeneratedText({
      texts: [textOfLength(half), textOfLength(half)],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(result.released).toBe(false);
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('logs the over-cap withhold with its own stage, and never the text', async () => {
    await screenGeneratedText({
      texts: [textOfLength(MAX_SCANNED_CONTENT_CHARS + 1)],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      stage: 'over-cap',
      capChars: MAX_SCANNED_CONTENT_CHARS,
    });
    expect(JSON.stringify(mockLogToAxiom.mock.calls)).not.toContain('xxxxxxxxxx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE VERDICT MEMO — the poll loop must not re-scan identical content.
// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — the per-content verdict memo', () => {
  const opts = {
    userId: 42,
    isGreen: false,
    appId: 'app-1',
    stepId: 'fixture-chat',
    model: CHAT_TYPE,
  };

  it('scans ONCE for repeated identical content, and the verdict is unchanged', async () => {
    // 🔴 THE DEFECT: `attachModeratedStepTextOutputs` runs on EVERY
    // `pollWorkflow`, at a cadence untrusted block code chooses, and the
    // orchestrator's own contentHash dedup is deliberately bypassed on this path
    // — so without a host-side memo one generation is an unbounded number of
    // identical scans.
    scannerReturns(scanOutput([]));
    const first = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    const second = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ released: true, texts: [GENERATED_TEXT] });
    expect(second).toEqual(first);
  });

  it('🔴 POSITIVE CONTROL — DIFFERENT content scans again', async () => {
    // Without this, "called once" is what a memo that returns a stale verdict
    // for EVERYTHING also produces — which would be a moderation hole, not an
    // optimization.
    scannerReturns(scanOutput([]));
    await screenGeneratedText({ ...opts, texts: ['first reply'] });
    await screenGeneratedText({ ...opts, texts: ['a completely different reply'] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
  });

  it('🔴 the maturity ceiling is part of the key — a mature-host release is NOT reused for a SFW viewer', () => {
    // `Suggestive` releases on a mature-allowed host and withholds on a SFW one.
    // A memo keyed on content alone would serve the first verdict to the second
    // viewer, which is the SFW tier silently disabled.
    return (async () => {
      scannerReturns(scanOutput(['Suggestive']));
      const mature = await screenGeneratedText({
        ...opts,
        isGreen: false,
        texts: [GENERATED_TEXT],
      });
      const sfw = await screenGeneratedText({ ...opts, isGreen: true, texts: [GENERATED_TEXT] });
      expect(mature.released).toBe(true);
      expect(sfw.released).toBe(false);
      // Two scans, because the two viewers do not share a key.
      expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
    })();
  });

  it('a WITHHELD verdict is memoized too — the expensive case is the one a block hammers', async () => {
    scannerReturns(scanOutput(['Young']));
    const first = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    const second = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(first.released).toBe(false);
    expect(second).toEqual(first);
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(1);
  });

  it('🔴 an ERROR is NOT memoized — a scanner recovery must not be pinned shut for 5 minutes', async () => {
    // Fail-closed is right for the failing call; caching it would turn a blip
    // into an outage of the capability, and would also mean a fixed scanner is
    // never retried. So the second call must reach the scanner again — and
    // succeed.
    mockCreateXGuardModerationRequest.mockRejectedValueOnce(new Error('orchestrator 503'));
    const failed = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(failed.released).toBe(false);

    scannerReturns(scanOutput([]));
    const recovered = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(recovered).toEqual({ released: true, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
  });

  it('🔴 a NO-VERDICT withhold is NOT memoized either — the OTHER uncached branch', async () => {
    // The memo's comment claims errors, timeouts AND missing outputs are all
    // excluded; only the error branch was pinned. These are TWO branches, not
    // three: an error and a timeout both land in the same `catch` (the hard
    // deadline rejects the same promise), while "the submit resolved but there
    // is no xGuardModeration output" is its own `if (!output)` exit — and it was
    // the unpinned one. A `writeCachedVerdict` moved above that exit would pin a
    // transient no-verdict shut for five minutes.
    mockCreateXGuardModerationRequest.mockResolvedValueOnce({
      id: 'scan-wf',
      status: 'processing',
      steps: [],
    });
    const noVerdict = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(noVerdict).toEqual({ released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE });

    scannerReturns(scanOutput([]));
    const recovered = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(recovered).toEqual({ released: true, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
  });

  it('🔴 a LABEL-DRIFT withhold is NOT memoized — it is an operational fault, like an error', async () => {
    // 🔴 THE DECISION THIS PINS. Drift is a fault in THIS file's own constant
    // (or in the scanner's label config), not a content hit, and it clears the
    // moment the fault does — a mid-deploy scanner fleet answering on some
    // instances and not others, or a label config being put back. Memoizing it
    // would pin the withhold through that recovery for five minutes, which is
    // the exact reason the error branch is not cached. An earlier revision
    // wrote the cache BEFORE the drift branch and so cached one and not the
    // other, with nothing asserting either way.
    const full = scanOutput([]);
    mockCreateXGuardModerationRequest.mockResolvedValueOnce({
      id: 'scan-wf',
      status: 'succeeded',
      steps: [
        {
          $type: 'xGuardModeration',
          output: { ...full, results: full.results.filter((r) => r.label !== 'Bestiality') },
        },
      ],
    });
    const drifted = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(drifted).toEqual({ released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ stage: 'label-drift' });

    // The fault clears. The very next call must reach the scanner and release.
    scannerReturns(full);
    const recovered = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(recovered).toEqual({ released: true, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
  });

  it('🔴 CONTROL FOR THE PAIR ABOVE — a POLICY withhold on the same content IS memoized', async () => {
    // Without this, "the second call rescanned" is what a memo that stores
    // nothing at all also produces, and the two exclusions above would be green
    // for the wrong reason. Same content, same TTL, only the withhold's CAUSE
    // differs: a content hit is cached, an operational fault is not.
    scannerReturns(scanOutput(['Young']));
    await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(1);
  });

  it('the entry cap is 1,000 — pinned LITERALLY', () => {
    // 🔴 A VALUE PIN. The eviction bound was unpinned: collapsing it to 1
    // disables the memo outright (every write evicts the previous entry) and
    // nothing observed it, because every other memo test uses one or two
    // distinct contents and fits inside any cap ≥ 2.
    expect(VERDICT_CACHE_MAX_ENTRIES).toBe(1_000);
  });

  it('🔴 evicts the OLDEST entry at the cap, and only at the cap', async () => {
    // The behavioural half of the pin above: it pins that eviction HAPPENS, at
    // the cap, oldest-first. Deleting the eviction block kills it (measured).
    //
    // 🔴 IT DOES *NOT* PIN THE VALUE, and saying otherwise would be the same
    // mistake the content-cap block records: this test derives its loop bound
    // FROM the constant, so it moves with any change to it — a 1000 → 1 mutant
    // (which disables the memo outright) leaves this test green and is caught
    // ONLY by the literal pin above. Measured, not assumed. Keep both.
    scannerReturns(scanOutput([]));
    const OLDEST = 'reply number 0';
    for (let i = 0; i < VERDICT_CACHE_MAX_ENTRIES; i++) {
      await screenGeneratedText({ ...opts, texts: [`reply number ${i}`] });
    }
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(VERDICT_CACHE_MAX_ENTRIES);

    // Still cached AT the cap — a hit, so no new scan and no re-insertion.
    await screenGeneratedText({ ...opts, texts: [OLDEST] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(VERDICT_CACHE_MAX_ENTRIES);

    // One more distinct content pushes past the cap and evicts the oldest…
    await screenGeneratedText({ ...opts, texts: ['one over the cap'] });
    // …so the oldest now MISSES and is rescanned: 1000 + 1 (over-cap) + 1 (miss).
    await screenGeneratedText({ ...opts, texts: [OLDEST] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(VERDICT_CACHE_MAX_ENTRIES + 2);
  });

  it('a memo HIT returns the CALLER’s own pieces, not the stored ones', async () => {
    // The key is the JOINED content, so two callers can share a hit having split
    // their pieces differently. Replaying a stored array would hand one of them
    // the other's segmentation.
    scannerReturns(scanOutput([]));
    const joined = 'alpha\n\nbeta';
    await screenGeneratedText({ ...opts, texts: [joined] });
    const split = await screenGeneratedText({ ...opts, texts: ['alpha', 'beta'] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(1);
    expect(split).toEqual({ released: true, texts: ['alpha', 'beta'] });
  });

  it('the memo does not survive a reset (the seam these tests depend on works)', async () => {
    // 🔴 VALIDATES THE HARNESS. Every pair above rests on `beforeEach` clearing
    // the memo; if the reset were a no-op, the second half of each pair would be
    // reading the first half's verdict and the whole block would be green for
    // the wrong reason.
    scannerReturns(scanOutput([]));
    await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    __clearTextOutputVerdictCacheForTests();
    await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 LABEL DRIFT — a label we ASKED for and did not get an answer on withholds.
//
// The generated client documents the fail-open in so many words
// (`types.gen.d.ts`, `xGuardModeration.labels`): *"Labels not found in the
// defaults (or label overrides) are silently ignored."* So a renamed or mistyped
// entry in `TEXT_OUTPUT_SCAN_LABELS` is never evaluated, comes back absent
// rather than errored, produces a clean verdict, and RELEASES — with no symptom
// at all. `normalizeLabel` covers CASING and cannot cover RENAMES.
// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — a dropped label FAILS CLOSED', () => {
  it('missingRequestedLabels names exactly the labels with no results[] entry', () => {
    const output = {
      triggeredLabels: [],
      results: [{ label: 'Young', score: 0.01, triggered: false }],
    };
    expect(missingRequestedLabels(output, ['Young', 'Grooming', 'Extremism'])).toEqual([
      'Grooming',
      'Extremism',
    ]);
    expect(missingRequestedLabels(output, ['Young'])).toEqual([]);
  });

  it('matches on the NORMALIZED key — a casing difference is not a drop', () => {
    // The two sides are orchestrator-side config this codebase does not control;
    // treating `young` vs `Young` as a drop would withhold everything for a
    // difference that is already handled elsewhere in this file.
    const output = { results: [{ label: 'young', triggered: false }] };
    expect(missingRequestedLabels(output, ['Young'])).toEqual([]);
  });

  it('WITHHOLDS a verdict that is otherwise clean when a requested label is missing', () => {
    // 🔴 THE REACHABILITY CASE. Nothing triggered; the pre-fix policy released.
    const output = scanOutput([]);
    const dropped = {
      ...output,
      results: output.results.filter((r) => r.label !== 'Extremism'),
    };
    const verdict = decideTextOutputVerdict(dropped, { isGreen: false, requestedLabels: ALL });
    expect(verdict.released).toBe(false);
    expect(verdict.missingLabels).toEqual(['Extremism']);
    // …and it is NOT reported as a content hit, which would poison the per-app
    // trigger rates with an operational fault.
    expect(verdict.withholdingLabels).toEqual([]);
  });

  it('🔴 POSITIVE CONTROL — the SAME scan with the full results[] releases', () => {
    // ONLY the presence of the dropped label's result differs. Without this,
    // "released: false" is what a policy that withholds everything also reports.
    const verdict = decideTextOutputVerdict(scanOutput([]), {
      isGreen: false,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(true);
    expect(verdict.missingLabels).toEqual([]);
  });

  it('an EMPTY results[] withholds even with an empty triggeredLabels (the total fail-open)', () => {
    // The shape a wholesale label rename produces: the scanner ignores every
    // label we sent, answers nothing, and the pre-fix policy read that as clean.
    const verdict = decideTextOutputVerdict(
      { triggeredLabels: [], results: [] },
      { isGreen: false, requestedLabels: ALL }
    );
    expect(verdict.released).toBe(false);
    expect(verdict.missingLabels).toEqual([...ALL]);
  });

  it('end to end: a dropped label WITHHOLDS the text and logs stage "label-drift"', async () => {
    const output = scanOutput([]);
    scannerReturns({ ...output, results: output.results.filter((r) => r.label !== 'Bestiality') });
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(GENERATED_TEXT);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      stage: 'label-drift',
      missingLabels: ['Bestiality'],
    });
  });

  it('🔴 POSITIVE CONTROL — the same path publishes when every requested label came back', async () => {
    scannerReturns(scanOutput([]));
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toEqual([GENERATED_TEXT]);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('the scan CHECKS exactly the list it SENDS', async () => {
    // 🔴 `requestedLabels` is deliberately NOT defaulted inside
    // `decideTextOutputVerdict` — a default is how a caller ends up checking a
    // list it did not send. This pins that the two are the same expression.
    scannerReturns(scanOutput([]));
    await screenGeneratedText({
      texts: [GENERATED_TEXT],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    expect(mockCreateXGuardModerationRequest.mock.calls[0][0].labels).toEqual([
      ...TEXT_OUTPUT_SCAN_LABELS,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 AN ERRORED LABEL — the scanner ATTEMPTED a label and FAILED on it.
//
// `XGuardLabelResult` carries `error?: null | string` (generated client,
// `types.gen.d.ts`). A label the scanner tried and failed on comes back as a
// PRESENT `results[]` entry with `triggered: false` and an `error` string. Before
// the fix that entry (a) satisfied the drift guard, because the guard's only
// question is whether a `label` came back at all, and (b) contributed nothing to
// `triggered` — so it read as a CLEAN ANSWER and the verdict RELEASED. A scan
// where all fifteen labels errored was byte-indistinguishable, to this policy,
// from a scan where all fifteen came back clean.
//
// That is the same "'no answer' must never read as 'clean'" invariant the drift
// guard's own comment states, failing on a different axis: drift is a label that
// was never EVALUATED, an error is a label whose evaluation FAILED. Both are
// non-answers; every other branch in this file (scanner throw, hard deadline,
// no-verdict, over-cap, drift) withholds on one.
//
// 🔴 THE FIXTURES BELOW ARE DELIBERATELY NOT `scanOutput(...)`-SHAPED. The
// existing fixture builds `results[]` by mapping ONE shape over
// `TEXT_OUTPUT_SCAN_LABELS`, so every entry covaries: a case built that way
// cannot tell "the errored label withheld" from "some label withheld". Here the
// errored label, the triggered label and the clean label are three DIFFERENT
// labels with three pairwise-distinct scores, and a test below asserts that
// distinctness so it cannot rot into a covarying fixture.
// ─────────────────────────────────────────────────────────────────────────────
describe('textOutput — an ERRORED label FAILS CLOSED', () => {
  /** Errored in the fixtures below. An ALWAYS-withhold label, so losing it matters. */
  const ERRORED_LABEL = 'Extremism';
  /** Genuinely triggers. A DIFFERENT always-withhold label. */
  const TRIGGERED_LABEL = 'Young';
  /** Neither errored nor triggered. A THIRD label, from the not-acted-on tier. */
  const CLEAN_LABEL = 'Celebrity';
  /**
   * The scanner-supplied error text. Asserted ABSENT from the trigger log: it is
   * an untrusted string from the other side of a network boundary and may quote
   * the very content this posture is withholding.
   */
  const SCANNER_ERROR = 'label backend timed out: upstream 504 on the-secret-content';

  /**
   * All fifteen results (which the drift guard genuinely requires — that is the
   * CODE's demand, not the fixture's assumption), with per-label overrides
   * applied on top so the fields do NOT covary.
   */
  function scanOutputWith(overrides: Record<string, Record<string, unknown>>) {
    const base = scanOutput([]);
    const results = base.results.map((r, i) => ({
      ...r,
      // Pairwise-distinct scores, so no assertion below can pass by matching the
      // wrong entry.
      score: 0.01 * (i + 1),
      ...(overrides[r.label] ?? {}),
    }));
    const triggeredLabels = results.filter((r) => r.triggered === true).map((r) => r.label);
    return { ...base, results, triggeredLabels };
  }

  /** The three subject labels, with an error on one and a trigger on another. */
  function erroredAndTriggered() {
    return scanOutputWith({
      [ERRORED_LABEL]: { error: SCANNER_ERROR, triggered: false, score: 0 },
      [TRIGGERED_LABEL]: { triggered: true, score: 0.97 },
    });
  }

  it('🔴 VALIDATES THE FIXTURE — the three subject labels and their scores are pairwise distinct', () => {
    // Without this, every case below could be green because one label happened
    // to stand in for another. It also pins that the three are really drawn from
    // three different policy tiers.
    expect(new Set([ERRORED_LABEL, TRIGGERED_LABEL, CLEAN_LABEL]).size).toBe(3);
    expect(ALWAYS_WITHHOLD_LABELS).toContain(ERRORED_LABEL);
    expect(ALWAYS_WITHHOLD_LABELS).toContain(TRIGGERED_LABEL);
    expect(NOT_ACTED_ON_LABELS).toContain(CLEAN_LABEL);

    const results = erroredAndTriggered().results;
    const byLabel = (l: string) => results.find((r) => r.label === l)!;
    expect(new Set(results.map((r) => r.score)).size).toBe(results.length);
    expect(byLabel(ERRORED_LABEL).triggered).toBe(false);
    expect(byLabel(TRIGGERED_LABEL).triggered).toBe(true);
    expect(byLabel(CLEAN_LABEL).triggered).toBe(false);
    expect(byLabel(CLEAN_LABEL)).not.toHaveProperty('error');
  });

  it('erroredRequestedLabels names exactly the requested labels whose entry carries an error', () => {
    const output = scanOutputWith({
      [ERRORED_LABEL]: { error: SCANNER_ERROR },
      [TRIGGERED_LABEL]: { triggered: true },
    });
    expect(
      TextOutputModeration.erroredRequestedLabels(output, [
        ERRORED_LABEL,
        TRIGGERED_LABEL,
        CLEAN_LABEL,
      ])
    ).toEqual([ERRORED_LABEL]);
  });

  it('🔴 ONE label errored, every other label clean → WITHHOLDS', () => {
    // 🔴 THE DEFECT, IN ONE ASSERTION. Nothing triggered, every requested label
    // came back, and one of them came back with an error instead of a verdict.
    // The pre-fix policy released this.
    const verdict = decideTextOutputVerdict(
      scanOutputWith({ [ERRORED_LABEL]: { error: SCANNER_ERROR } }),
      { isGreen: false, requestedLabels: ALL }
    );
    expect(verdict.released).toBe(false);
    expect(verdict.erroredLabels).toEqual([ERRORED_LABEL]);
    // 🔴 AND IT IS NOT MISATTRIBUTED. An errored label is present in `results[]`,
    // so it is NOT drift, and it is not a content hit either. Reporting it as
    // either would send an operator to the wrong remedy and poison that stage's
    // rates with a fault of a different kind.
    expect(verdict.missingLabels).toEqual([]);
    expect(verdict.withholdingLabels).toEqual([]);
  });

  it('🔴 POSITIVE CONTROL — the IDENTICAL scan with `error: null` RELEASES', () => {
    // Only the one field differs. Without this, "released: false" above is what a
    // policy that withholds everything also reports.
    const verdict = decideTextOutputVerdict(scanOutputWith({ [ERRORED_LABEL]: { error: null } }), {
      isGreen: false,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(true);
    expect(verdict.erroredLabels).toEqual([]);
  });

  it('🔴 POSITIVE CONTROL — with the `error` field ABSENT entirely it RELEASES', () => {
    const verdict = decideTextOutputVerdict(scanOutputWith({}), {
      isGreen: false,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(true);
    expect(verdict.erroredLabels).toEqual([]);
  });

  it('🔴 ALL FIFTEEN labels errored → WITHHOLDS, and names all fifteen', () => {
    // The shape a whole-scanner fault produces. Pre-fix this was
    // indistinguishable from fifteen clean answers — the single worst case,
    // because it is the one where the scan did nothing at all.
    const overrides = Object.fromEntries(
      TEXT_OUTPUT_SCAN_LABELS.map((l) => [l, { error: `${SCANNER_ERROR} (${l})` }])
    );
    const verdict = decideTextOutputVerdict(scanOutputWith(overrides), {
      isGreen: false,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(false);
    expect(verdict.erroredLabels).toEqual([...TEXT_OUTPUT_SCAN_LABELS]);
    expect(verdict.missingLabels).toEqual([]);
  });

  it('🔴 an errored label that WOULD have been a withhold label still withholds', () => {
    // `Extremism` is an always-withhold label. If the scanner failed on it, we do
    // not know whether the text trips it — which is exactly the case the policy
    // must not resolve in the text's favour. Note `withholdingLabels` is empty:
    // we are not claiming it triggered, we are claiming we never found out.
    const verdict = decideTextOutputVerdict(
      scanOutputWith({ [ERRORED_LABEL]: { error: SCANNER_ERROR, triggered: false } }),
      { isGreen: false, requestedLabels: ALL }
    );
    expect(verdict.released).toBe(false);
    expect(verdict.erroredLabels).toEqual([ERRORED_LABEL]);
    expect(verdict.withholdingLabels).toEqual([]);
  });

  it('🔴 an error alongside `triggered: true` on the SAME label withholds on BOTH signals', () => {
    // A partial failure that still reported a trigger. Fail-closed in both
    // directions: the trigger is honoured (it is a policy label) AND the error is
    // recorded, so neither signal is dropped in favour of the other.
    const verdict = decideTextOutputVerdict(
      scanOutputWith({ [TRIGGERED_LABEL]: { error: SCANNER_ERROR, triggered: true } }),
      { isGreen: false, requestedLabels: ALL }
    );
    expect(verdict.released).toBe(false);
    expect(verdict.erroredLabels).toEqual([TRIGGERED_LABEL]);
    expect(verdict.triggeredLabels).toContain(TRIGGERED_LABEL);
    expect(verdict.withholdingLabels).toEqual([TRIGGERED_LABEL]);
  });

  it('an error on ONE label and a genuine trigger on ANOTHER reports both, separately', () => {
    const verdict = decideTextOutputVerdict(erroredAndTriggered(), {
      isGreen: false,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(false);
    expect(verdict.erroredLabels).toEqual([ERRORED_LABEL]);
    expect(verdict.withholdingLabels).toEqual([TRIGGERED_LABEL]);
  });

  it('🔴 a non-string, non-null `error` value withholds too (fail closed on a shape we did not expect)', () => {
    // `error` is `null | string` in the generated client, but this is untrusted
    // data off a network boundary and the `Like` types read it as `unknown`. A
    // value we cannot interpret is a non-answer, not a clean one.
    for (const value of [42, {}, [], true]) {
      const verdict = decideTextOutputVerdict(
        scanOutputWith({ [ERRORED_LABEL]: { error: value } }),
        { isGreen: false, requestedLabels: ALL }
      );
      expect(verdict.released).toBe(false);
      expect(verdict.erroredLabels).toEqual([ERRORED_LABEL]);
    }
  });

  it('an EMPTY-STRING error is NOT an error (documented; the alternative is a total outage)', () => {
    // 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — this passes pre-fix too, and
    // it is here to pin a decision rather than to catch the defect. `modelReason`
    // came back EMPTY on every probe against the deployed scanner, so a scanner
    // that populates `error: ''` on the healthy path is a live possibility.
    // Treating `''` as a fault would withhold 100% of output on day one — the
    // same day-one capability outage the drift guard's pre-adoption gate warns
    // about. The PRESENCE of a non-empty error is the signal.
    const verdict = decideTextOutputVerdict(scanOutputWith({ [ERRORED_LABEL]: { error: '   ' } }), {
      isGreen: false,
      requestedLabels: ALL,
    });
    expect(verdict.released).toBe(true);
    expect(verdict.erroredLabels).toEqual([]);
  });

  it('`finishReason` alone does NOT withhold', () => {
    // 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — green pre-fix and post-fix.
    // It pins a DELIBERATE non-decision so a later reader does not quietly make
    // the opposite one. `finishReason?: null | string` sits next to `error` in
    // the same generated type and plausibly carries a comparable signal (a
    // truncated judge output is also a degraded answer), but unlike `error` it
    // cannot be read by PRESENCE: a finishReason is emitted on the healthy path
    // too, so acting on it requires knowing which VALUES mean "fine". That value
    // set is orchestrator-side configuration this codebase does not control and
    // has never observed — the same category `normalizeLabel`'s comment warns
    // about for label strings. Guessing it wrong in the strict direction
    // withholds everything; guessing it wrong in the loose direction is the
    // fail-open we are already fixing. So: no action until a live probe
    // establishes the distribution. See the source comment for the gate.
    const verdict = decideTextOutputVerdict(
      scanOutputWith({
        [ERRORED_LABEL]: { finishReason: 'length' },
        [CLEAN_LABEL]: { finishReason: 'stop' },
      }),
      { isGreen: false, requestedLabels: ALL }
    );
    expect(verdict.released).toBe(true);
    expect(verdict.erroredLabels).toEqual([]);
  });

  it('an error on a label we did NOT request is ignored (the guard is scoped to what we asked)', () => {
    // 🔴 INVARIANT GUARD / SCOPING PIN — green pre-fix and post-fix. Symmetric
    // with `missingRequestedLabels`: this policy makes claims only about the
    // labels it sent. Unreachable from `screenGeneratedText`, which always sends
    // the full list; pinned so the scoping is a decision rather than an accident.
    const verdict = decideTextOutputVerdict(
      scanOutputWith({ [ERRORED_LABEL]: { error: SCANNER_ERROR } }),
      { isGreen: false, requestedLabels: [TRIGGERED_LABEL, CLEAN_LABEL] }
    );
    expect(verdict.released).toBe(true);
    expect(verdict.erroredLabels).toEqual([]);
  });

  it('🔴 END TO END — an errored label WITHHOLDS the text and logs stage "label-error"', async () => {
    scannerReturns(scanOutputWith({ [ERRORED_LABEL]: { error: SCANNER_ERROR } }));
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(GENERATED_TEXT);
    expect(snapshot.textOutputWithheld).toEqual({ reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      stage: 'label-error',
      erroredLabels: [ERRORED_LABEL],
    });
  });

  it('🔴 POSITIVE CONTROL — the SAME path publishes when no label errored', async () => {
    // ONLY the `error` field differs from the case above.
    scannerReturns(scanOutputWith({}));
    const snapshot = await attachModeratedStepTextOutputs(
      { workflowId: 'wf-1', status: 'succeeded' as const },
      workflowWith(chatStep()),
      CTX
    );
    expect(snapshot.textOutputs).toEqual([GENERATED_TEXT]);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('🔴 the log carries NEITHER the withheld text NOR the scanner-supplied error string', async () => {
    // The error string comes from the other side of a network boundary and can
    // quote the content being scanned. The label NAMES are this file's own
    // constants and are safe; the message is not, and a store that must never
    // hold the withheld text must not hold a string that may embed it.
    scannerReturns(scanOutputWith({ [ERRORED_LABEL]: { error: SCANNER_ERROR } }));
    await screenGeneratedText({
      texts: [GENERATED_TEXT],
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    });
    const logged = JSON.stringify(mockLogToAxiom.mock.calls);
    expect(logged).not.toContain(GENERATED_TEXT);
    expect(logged).not.toContain(SCANNER_ERROR);
    expect(logged).not.toContain('the-secret-content');
    // …and the actionable part IS there.
    expect(logged).toContain(ERRORED_LABEL);
  });

  it('🔴 a LABEL-ERROR withhold is NOT memoized — a scanner recovery must not be pinned shut', async () => {
    // Same reasoning the error / no-verdict / drift branches already carry: a
    // per-label scanner fault is OPERATIONAL and clears on its own, so caching
    // the withhold would pin a blip into a five-minute outage of the capability
    // — and, because a memo HIT logs nothing, would emit the `label-error` line
    // for the first observation only and then go silent.
    const opts = {
      userId: 42,
      isGreen: false,
      appId: 'app-1',
      stepId: 'fixture-chat',
      model: CHAT_TYPE,
    };
    scannerReturns(scanOutputWith({ [ERRORED_LABEL]: { error: SCANNER_ERROR } }));
    const errored = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(errored).toEqual({ released: false, reason: TEXT_OUTPUT_WITHHELD_MESSAGE });

    // The fault clears. The very next call must reach the scanner again, and
    // release.
    scannerReturns(scanOutputWith({}));
    const recovered = await screenGeneratedText({ ...opts, texts: [GENERATED_TEXT] });
    expect(recovered).toEqual({ released: true, texts: [GENERATED_TEXT] });
    expect(mockCreateXGuardModerationRequest).toHaveBeenCalledTimes(2);
  });
});
