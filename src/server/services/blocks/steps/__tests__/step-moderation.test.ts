import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

/**
 * Coverage for the step-registry MODERATION dispatch (`./moderation`).
 *
 * 🔴 WHAT THIS SUITE HAS TO PROVE, and why each one is not obvious:
 *
 *  1. The `'promptAudit'` handler REALLY CALLS `auditPromptServer`. Deleting the
 *     call must fail a test on its own assertion — not merely leave a mock
 *     unasserted.
 *  2. `isGreen` is PASSED THROUGH from the caller, never constant. Hardcoding it
 *     either way must fail.
 *  3. An empty/whitespace prompt at REQUEST time is REJECTED, not audited.
 *     `auditPromptServer` returns early on an empty prompt, so "call it anyway"
 *     is indistinguishable from a clean audit.
 *  4. A flagged prompt PROPAGATES. No try/catch may be added around the audit:
 *     fail-soft is `auditPromptServer`'s own behaviour for a moderation-service
 *     outage, not a licence to swallow a block.
 *  5. The handler table and `isModerationPostureImplemented` cannot drift.
 *
 * `auditPromptServer` is mocked at the module boundary (it pulls Redis,
 * ClickHouse, the DB client and the notification service).
 */

const { mockAuditPromptServer } = vi.hoisted(() => ({ mockAuditPromptServer: vi.fn() }));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: mockAuditPromptServer,
}));

import {
  mediaFromBlobs,
  STEP_MODERATION_POSTURES,
  type AnyBlockStep,
  type BlockStep,
  type StepModerationPosture,
} from '~/server/services/blocks/steps';
import type { OrchestratorBlobLike } from '~/server/services/blocks/steps/output';
import {
  assertModerationHandlerTable,
  runStepModeration,
  type StepModerationRequest,
} from '~/server/services/blocks/steps/moderation';

type FixtureParams = { prompt: string };

const fixtureParamSchema = z.object({ prompt: z.string() }).strict();

function makeStep(overrides: Partial<AnyBlockStep> = {}): AnyBlockStep {
  const base = {
    id: 'fixture-step',
    orchestratorType: 'fixtureType',
    billingMode: 'prepaidFixed',
    moderationPosture: 'promptAudit',
    resourcePolicy: { kind: 'none' },
    paramSchema: fixtureParamSchema,
    variants: ['default'],
    resolveVariant: () => 'default',
    canonicalParamsFor: (): FixtureParams => ({ prompt: 'a cat' }),
    auditableText: (p: FixtureParams) => ({ prompt: p.prompt, negativePrompt: 'blurry' }),
    priceForVariant: () => 7,
    estimateBuzz: () => 7,
    buildStep: (p: FixtureParams) => ({ $type: 'fixtureType', input: { prompt: p.prompt } }),
    extractOutput: (step: unknown) =>
      mediaFromBlobs(
        (step as { output?: { blob?: OrchestratorBlobLike | null } } | null | undefined)?.output
          ?.blob
      ),
    canonicalOutputFor: (): unknown => ({
      output: { blob: { url: 'https://blobs.example/f.webp', available: true } },
    }),
  } satisfies BlockStep<FixtureParams>;
  return { ...base, ...overrides } as AnyBlockStep;
}

function request(over: Partial<StepModerationRequest> = {}): StepModerationRequest {
  return {
    step: makeStep(),
    params: { prompt: 'a cat' },
    userId: 42,
    isGreen: false,
    loadIsModerator: async () => false,
    ...over,
  };
}

beforeEach(() => {
  mockAuditPromptServer.mockReset();
  mockAuditPromptServer.mockResolvedValue(undefined);
});

describe("step moderation — the 'promptAudit' handler", () => {
  it('runs auditPromptServer with the entry-declared text', async () => {
    // 🔴 MUTATION TARGET (a): delete the `await auditPromptServer({...})` call in
    // the handler and this assertion fails on `toHaveBeenCalledTimes(1)`.
    await runStepModeration(request());
    expect(mockAuditPromptServer).toHaveBeenCalledTimes(1);
    expect(mockAuditPromptServer).toHaveBeenCalledWith({
      prompt: 'a cat',
      negativePrompt: 'blurry',
      userId: 42,
      isGreen: false,
      isModerator: false,
    });
  });

  it('audits the SUBMITTED params, not the canonical ones', async () => {
    // The params an untrusted iframe actually sent are what must be audited — a
    // handler that read `canonicalParamsFor()` would audit a constant forever.
    await runStepModeration(request({ params: { prompt: 'something else entirely' } }));
    expect(mockAuditPromptServer.mock.calls[0][0]).toMatchObject({
      prompt: 'something else entirely',
    });
  });

  it('PASSES THROUGH isGreen in both directions — it is never a constant', async () => {
    // 🔴 MUTATION TARGET (c), handler half: hardcoding `isGreen: true` fails the
    // first assertion, hardcoding `false` fails the second. Neither can pass both.
    await runStepModeration(request({ isGreen: false }));
    expect(mockAuditPromptServer.mock.calls[0][0].isGreen).toBe(false);

    mockAuditPromptServer.mockClear();
    await runStepModeration(request({ isGreen: true }));
    expect(mockAuditPromptServer.mock.calls[0][0].isGreen).toBe(true);
  });

  it('resolves isModerator through the caller-supplied thunk', async () => {
    const loadIsModerator = vi.fn().mockResolvedValue(true);
    await runStepModeration(request({ loadIsModerator }));
    expect(loadIsModerator).toHaveBeenCalledTimes(1);
    expect(mockAuditPromptServer.mock.calls[0][0].isModerator).toBe(true);
  });

  it('omits negativePrompt when the entry declares none', async () => {
    await runStepModeration(
      request({
        step: makeStep({
          auditableText: () => ({ prompt: 'only positive' }),
        } as Partial<AnyBlockStep>),
      })
    );
    expect(mockAuditPromptServer.mock.calls[0][0].negativePrompt).toBeUndefined();
  });

  // 🔴 THE FAIL-CLOSED CLAUSE. `auditPromptServer` returns early on an empty
  // prompt, so calling it with one is a posture that audits NOTHING and reports
  // success. These reject instead.
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \n\t '],
  ])('REJECTS %s as unauditable rather than submitting it unaudited', async (_label, prompt) => {
    await expect(
      runStepModeration(
        request({ step: makeStep({ auditableText: () => ({ prompt }) } as Partial<AnyBlockStep>) })
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('carry no auditable text'),
    });
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
  });

  it('REJECTS a promptAudit entry whose auditableText is missing at request time', async () => {
    // Registry load already blocks this shape; the handler re-asserts it because
    // this is the seam a policy mistake arrives through.
    await expect(
      runStepModeration(
        request({ step: makeStep({ auditableText: undefined } as Partial<AnyBlockStep>) })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
  });

  it('PROPAGATES a flagged prompt — the audit is never wrapped in a catch', async () => {
    // 🔴 Fail-soft is `auditPromptServer`'s OWN behaviour for a moderation-service
    // outage (it catches the extModeration error internally and continues). A
    // catch HERE would turn a genuinely flagged prompt into a silent pass.
    const flagged = Object.assign(new Error('Your prompt was flagged: x'), {
      code: 'BAD_REQUEST',
    });
    mockAuditPromptServer.mockRejectedValue(flagged);
    await expect(runStepModeration(request())).rejects.toThrow('Your prompt was flagged: x');
  });
});

describe('step moderation — dispatch over the posture table', () => {
  it("the 'none' posture runs nothing and does not resolve the viewer", async () => {
    // The zero-cost property the step path deliberately has today: no audit call,
    // and no `getUserById` round-trip behind the thunk.
    const loadIsModerator = vi.fn();
    await runStepModeration(
      request({
        step: makeStep({
          moderationPosture: 'none',
          auditableText: undefined,
        } as Partial<AnyBlockStep>),
        loadIsModerator,
      })
    );
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
    expect(loadIsModerator).not.toHaveBeenCalled();
  });

  it("the unimplemented 'textOutput' posture FAILS CLOSED with a named error", async () => {
    // Never `undefined is not a function`: a deliberate, named 500 on the seam.
    await expect(
      runStepModeration(
        request({
          step: makeStep({
            moderationPosture: 'textOutput',
            auditableText: undefined,
          } as Partial<AnyBlockStep>),
        })
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: "step 'fixture-step' declares an unimplemented moderation posture",
    });
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
  });

  it('is TOTAL over every declared posture — no key reads as undefined', async () => {
    for (const posture of STEP_MODERATION_POSTURES) {
      const step = makeStep({
        moderationPosture: posture,
        ...(posture === 'promptAudit' ? {} : { auditableText: undefined }),
      } as Partial<AnyBlockStep>);
      let error: unknown;
      try {
        await runStepModeration(request({ step }));
      } catch (e) {
        error = e;
      }
      if (posture === 'textOutput') {
        expect(String((error as { message?: string })?.message)).toContain(
          'unimplemented moderation posture'
        );
      } else {
        expect(error, `posture '${posture}' should have an implemented handler`).toBeUndefined();
      }
    }
  });
});

describe('step moderation — the handler table cannot drift from the declaration', () => {
  const noop = async () => undefined;

  it('the SHIPPED table passes (it is asserted at module load; this pins it)', () => {
    expect(() =>
      assertModerationHandlerTable({ none: noop, promptAudit: noop, textOutput: null })
    ).not.toThrow();
  });

  it('rejects an IMPLEMENTED posture whose handler is absent (a 500 on a spend path)', () => {
    expect(() =>
      assertModerationHandlerTable({ none: noop, promptAudit: null, textOutput: null })
    ).toThrow(/posture 'promptAudit' is declared IMPLEMENTED but its handler is absent/);
  });

  it('rejects an UNIMPLEMENTED posture that has a handler (the gate would be a lie)', () => {
    expect(() =>
      assertModerationHandlerTable({ none: noop, promptAudit: noop, textOutput: noop })
    ).toThrow(/posture 'textOutput' is declared UNIMPLEMENTED but its handler is present/);
  });

  it('checks EVERY declared posture, not just the first', () => {
    // A loop that broke early would pass the previous two tests and still miss a
    // drifted posture further down the list.
    const postures = [...STEP_MODERATION_POSTURES] as StepModerationPosture[];
    expect(postures).toEqual(['none', 'promptAudit', 'textOutput']);
    expect(() =>
      assertModerationHandlerTable({ none: null, promptAudit: noop, textOutput: null })
    ).toThrow(/posture 'none' is declared IMPLEMENTED but its handler is absent/);
  });
});
