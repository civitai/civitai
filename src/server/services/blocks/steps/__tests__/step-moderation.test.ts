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

const { mockAuditPromptServer, mockCreateXGuardModerationRequest } = vi.hoisted(() => ({
  mockAuditPromptServer: vi.fn(),
  mockCreateXGuardModerationRequest: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: mockAuditPromptServer,
}));
// The OUTPUT phase reaches `createXGuardModerationRequest`, which pulls the
// Prisma client and the orchestrator HTTP client at import time. Mocked at the
// module boundary for the same reason `auditPromptServer` is.
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: mockCreateXGuardModerationRequest,
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

  // 🔴 THE `negativePrompt` TYPE CLAUSE. `./index` clause 5a checks this at
  // registry LOAD against canonical params; this checks the params actually
  // submitted. Without it a non-string reaches `stripBenignPhrases` inside
  // `auditPromptServer`'s own try (`text.replace is not a function`), the catch
  // treats it as a moderation hit, and on the non-green path it writes a
  // `BlockedPromptEntry` and increments the AUTO-MUTE counter before rethrowing
  // "Your prompt was flagged". Innocent users would take a mute-counter hit on
  // every submit, so "the audit was not called" is the assertion that matters.
  it.each([
    ['a number', 42],
    ['an object', { toString: () => 'sneaky' }],
    ['null', null],
  ])(
    'REJECTS %s as negativePrompt BEFORE auditPromptServer is called',
    async (_label, negativePrompt) => {
      const error = await runStepModeration(
        request({
          step: makeStep({
            auditableText: () => ({ prompt: 'a cat', negativePrompt }),
          } as unknown as Partial<AnyBlockStep>),
        })
      ).then(
        () => undefined,
        (e) => e
      );

      expect(
        mockAuditPromptServer,
        'auditPromptServer must not be reached with a negativePrompt it cannot read — its ' +
          'internal catch would record a BlockedPromptEntry and bump the auto-mute counter'
      ).not.toHaveBeenCalled();
      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('non-string negativePrompt'),
      });
    }
  );

  it('still passes a legitimate string negativePrompt straight through', async () => {
    // The negative control for the clause above: it must reject a bad type, not
    // every negativePrompt.
    await runStepModeration(request());
    expect(mockAuditPromptServer.mock.calls[0][0].negativePrompt).toBe('blurry');
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

  it("the 'textOutput' posture runs NOTHING at submit and does not resolve the viewer", async () => {
    // 🔴 THE INERTNESS TRAP, ASSERTED FROM THE SUBMIT SIDE. `'textOutput'` scans
    // GENERATED text, which does not exist at submit — the orchestrator has not
    // been called. So the correct submit-phase behaviour is to do nothing, and
    // the thing that makes that safe rather than inert is that the posture's
    // REQUIRED phase is `output` (`posturePhaseRequirements`), asserted at module
    // load. A submit-phase handler for this posture is a BUILD failure; see the
    // phase-table suite below.
    const loadIsModerator = vi.fn();
    await runStepModeration(
      request({
        step: makeStep({
          moderationPosture: 'textOutput',
          auditableText: undefined,
        } as Partial<AnyBlockStep>),
        loadIsModerator,
      })
    );
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
    expect(loadIsModerator).not.toHaveBeenCalled();
  });

  // 🔴 THE PROTOTYPE-KEY ATTACK. A plain object literal inherits from
  // `Object.prototype`, so `handlers['toString']` returns
  // `Object.prototype.toString` — TRUTHY. `!handler` would then be false,
  // `await handler(req)` would RESOLVE, and `runStepModeration` would return
  // cleanly having audited nothing and thrown nothing: the fail-closed guard
  // failing OPEN, for the exact keys an attacker would pick. Verified by
  // execution before the fix. The table's null prototype is what makes these
  // read `undefined`.
  //
  // These are the two keys that produce the SILENT ALLOW: reverting the table to
  // a plain object literal fails both on `promise resolved "undefined" instead
  // of rejecting`, because `Object.prototype.toString.call(undefined)` returns a
  // string and `Object(req)` returns `req` — neither throws. A plain unknown
  // string like `'nope'` does NOT cover this; that key misses the prototype too,
  // which is why the pre-fix code already handled it.
  it.each([['toString'], ['constructor']])(
    "FAILS CLOSED on the Object.prototype key '%s' — it must not resolve to an inherited method",
    async (posture) => {
      await expect(
        runStepModeration(
          request({
            step: makeStep({
              moderationPosture: posture,
              auditableText: undefined,
            } as unknown as Partial<AnyBlockStep>),
          })
        )
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: "step 'fixture-step' declares an unimplemented moderation posture",
      });
      expect(mockAuditPromptServer).not.toHaveBeenCalled();
    }
  );

  // The remaining inherited keys, kept separate and NOT counted as clean kills.
  // ⚠️ DISCLOSED: with the null prototype reverted these do not silently allow —
  // `Object.prototype.valueOf` / `.hasOwnProperty` invoked with `this ===
  // undefined` (ESM is strict) and `__proto__` resolving to a non-callable
  // `Object.prototype` all throw a raw `TypeError`. So a mutation dies here to
  // JavaScript's error, not to this guard's. They are asserted because the named
  // 500 is the behaviour we want on every prototype key, not because they
  // demonstrate the fail-open.
  it.each([['valueOf'], ['hasOwnProperty'], ['__proto__']])(
    "also fails closed on '%s' (a raw TypeError pre-fix, not a silent allow)",
    async (posture) => {
      await expect(
        runStepModeration(
          request({
            step: makeStep({
              moderationPosture: posture,
              auditableText: undefined,
            } as unknown as Partial<AnyBlockStep>),
          })
        )
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: "step 'fixture-step' declares an unimplemented moderation posture",
      });
      expect(mockAuditPromptServer).not.toHaveBeenCalled();
    }
  );

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
      expect(error, `posture '${posture}' should have an implemented handler`).toBeUndefined();
    }
  });
});

describe('step moderation — the PHASE table cannot drift from the declaration', () => {
  const submitNoop = async () => undefined;
  const outputNoop = async () => ({ released: true as const, texts: [] });

  /** The shape the shipped table has. Every case below mutates exactly one slot. */
  const shipped = () => ({
    none: { submit: null, output: null },
    promptAudit: { submit: submitNoop, output: null },
    textOutput: { submit: null, output: outputNoop },
  });

  it('the SHIPPED shape passes (it is asserted at module load; this pins it)', () => {
    // 🔴 THE CONTROL. If this ever throws, every rejection below could be dying
    // to a clause other than the one it names.
    expect(() => assertModerationHandlerTable(shipped())).not.toThrow();
  });

  it('rejects a posture whose REQUIRED phase has no handler (a 500 on a spend path)', () => {
    expect(() =>
      assertModerationHandlerTable({ ...shipped(), promptAudit: { submit: null, output: null } })
    ).toThrow(/posture 'promptAudit' is declared IMPLEMENTED but its required phases are MISSING/);
  });

  it("rejects a 'textOutput' posture with no OUTPUT handler", () => {
    expect(() =>
      assertModerationHandlerTable({ ...shipped(), textOutput: { submit: null, output: null } })
    ).toThrow(/posture 'textOutput' is declared IMPLEMENTED but its required phases are MISSING/);
  });

  // 🔴 THE CLAUSE THAT MAKES THE POSTURE UN-FAKEABLE, AND THE REASON THE TABLE
  // IS KEYED BY PHASE AT ALL.
  //
  // This is the mutation that WOULD SHIP AN INERT FEATURE if the assert only
  // counted handlers: `'textOutput'` satisfied by a SUBMIT-phase handler. That
  // handler runs before the orchestrator call, so there is no generated text to
  // look at — it scans an empty string, returns cleanly, and reports success.
  // The registry gate would pass, the posture would read as implemented, and
  // generated text would reach blocks unscanned.
  //
  // Note what the assertion pins: the SUBMIT-PHASE message specifically, not
  // merely "it threw". A version of this test matching /textOutput/ alone would
  // also pass against the required-phase clause above and prove nothing about
  // this one.
  it("REJECTS 'textOutput' satisfied by a SUBMIT handler — the inert-feature shape", () => {
    expect(() =>
      assertModerationHandlerTable({
        ...shipped(),
        textOutput: { submit: submitNoop, output: outputNoop },
      })
    ).toThrow(
      /posture 'textOutput' declares a submit-phase handler, but its moderation surface is not in that phase/
    );
  });

  it("REJECTS 'promptAudit' carrying an OUTPUT handler — the mirror image", () => {
    // The same clause in the other direction, so it cannot be satisfied by a
    // one-sided check. An output handler on an input-only posture is a scan that
    // never runs, reading as generated-text coverage.
    expect(() =>
      assertModerationHandlerTable({
        ...shipped(),
        promptAudit: { submit: submitNoop, output: outputNoop },
      })
    ).toThrow(
      /posture 'promptAudit' declares a output-phase handler, but its moderation surface is not in that phase/
    );
  });

  it("REJECTS 'none' carrying a handler in either phase", () => {
    expect(() =>
      assertModerationHandlerTable({ ...shipped(), none: { submit: submitNoop, output: null } })
    ).toThrow(/posture 'none' declares a submit-phase handler/);
    expect(() =>
      assertModerationHandlerTable({ ...shipped(), none: { submit: null, output: outputNoop } })
    ).toThrow(/posture 'none' declares a output-phase handler/);
  });

  it('rejects a posture with NO phase entry at all', () => {
    expect(() =>
      assertModerationHandlerTable({
        ...shipped(),
        textOutput: undefined as unknown as { submit: null; output: null },
      })
    ).toThrow(/posture 'textOutput' has no phase entry/);
  });

  it('checks EVERY declared posture, not just the first', () => {
    // A loop that broke early would pass the cases above and still miss a
    // drifted posture further down the list.
    const postures = [...STEP_MODERATION_POSTURES] as StepModerationPosture[];
    expect(postures).toEqual(['none', 'promptAudit', 'textOutput']);
    expect(() =>
      assertModerationHandlerTable({ ...shipped(), textOutput: { submit: null, output: null } })
    ).toThrow(/posture 'textOutput'/);
  });
});
