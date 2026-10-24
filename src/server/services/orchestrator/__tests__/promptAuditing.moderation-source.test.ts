import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuditModule from '~/utils/metadata/audit';

/**
 * 🔴 SEAM GUARD for the `moderationSource` label — `auditPromptServer` → `extModeration.moderatePrompt`.
 *
 * WHY THIS FILE EXISTS. Every other test around this feature is scoped to ONE side of the seam:
 * `external-moderation.metrics.test.ts` proves the histogram records whatever source it is handed,
 * and `moderation.instrumentation.test.ts` proves `moderatePrompt` labels an observation with
 * whatever source IT is handed. Neither loads the code that decides which source to hand over, so
 * both stay green when the value stops being passed at all. Measured in the round-1 audit:
 * substituting a literal `undefined` for `moderationSource` at the `moderatePrompt` call site in
 * `promptAuditing.ts` survived the ENTIRE unit suite — every file green, an identical pass count.
 * Re-run against THIS file, the same mutant fails five of its six cases.
 *
 * WHAT THAT MUTANT DOES IN PRODUCTION. `source="generate"` and `source="preset"` go permanently
 * empty and 100 % of observations pile onto `other`. That is worse than a wrong number: an empty
 * `generate` series is INDISTINGUISHABLE from "no generations happened", and reading
 * `source=generate` is exactly the query the metric's own help text tells an operator to run.
 * `tsc` cannot see it either — `moderationSource` is optional, so `undefined` is assignable.
 *
 * WHY THE EXISTING ASSERTIONS DID NOT COVER IT. Two sibling tests assert
 * `toHaveBeenCalledWith(auditedPrompt, undefined)`. That pins the DEFAULT and the ARITY — both
 * worth having — but `undefined` is precisely the mutant's value, so it can only ever agree with
 * it. Nothing anywhere pinned a DECLARED source travelling end to end. This file does, over the
 * whole vocabulary, so a mutant that drops the argument or hardcodes any one value fails here and
 * names the source it failed on.
 *
 * The mock preamble follows `promptAuditing.benign-phrases.test.ts` MINUS its redis block (see the
 * note beside the mocks) — it only keeps the heavy module graph inert so `promptAuditing` imports;
 * nothing below depends on any of it beyond `stripBenignPhrases` and `moderatePrompt`.
 */

const { mockStripBenignPhrases, mockAuditPromptEnriched, mockModeratePrompt, mockProhibited } =
  vi.hoisted(() => ({
    mockStripBenignPhrases: vi.fn(),
    mockAuditPromptEnriched: vi.fn(),
    mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
    mockProhibited: vi.fn(),
  }));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  auditPromptEnriched: mockAuditPromptEnriched,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));

// The redis client is NOT mocked here on purpose: `src/__tests__/setup.ts` registers the CANONICAL
// mock for it globally, and both `no-direct-shared-module-mock` and
// `no-hand-typed-redis-key-constants` fail a NEW file that declares its own (a hand-typed
// REDIS_KEYS drifts from production silently — 15 had, before #4400). The sibling
// benign-phrases file carries such a block only because it predates those guards. Note that both
// guards match TEXTUALLY, so do not spell the mock call for that module anywhere in this file,
// comments included.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));

// The db + logging clients are mocked GLOBALLY in src/__tests__/setup.ts, so nothing needs to be
// imported here to get them; this file only declares the module-graph stubs above that setup.ts
// does not own.
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

/**
 * The strip below removes ` marker`, so the audited copy differs from the raw prompt. That is
 * deliberate: the assertions pin BOTH arguments at once, so a mutant that swapped the audited copy
 * for the raw one would fail here too rather than being masked by an identical pair.
 */
const PROMPT = 'a serene landscape marker';
const AUDITED = 'a serene landscape';

const baseOptions = {
  prompt: PROMPT,
  negativePrompt: '',
  userId: 5,
  isGreen: false,
  track: { prohibitedRequest: mockProhibited },
};

/**
 * The full `ExternalModerationSource` vocabulary. Every member is swept, not just `generate`: a
 * mutant that hardcodes ANY one of them must fail on the other three.
 */
const ALL_SOURCES = ['generate', 'preset', 'remixAudit', 'other'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditPromptEnriched.mockReturnValue({ triggers: [], success: true });
  mockStripBenignPhrases.mockImplementation(async (text: string | undefined) =>
    text?.replace(/ marker/gi, '')
  );
});

describe('auditPromptServer — a DECLARED moderationSource reaches moderatePrompt', () => {
  it.each(ALL_SOURCES)(
    'hands the classifier the audited prompt AND the declared source %s',
    async (source) => {
      await expect(
        auditPromptServer({ ...baseOptions, moderationSource: source })
      ).resolves.toBeUndefined();

      // 🔴 THE ASSERTION THIS FILE EXISTS FOR. `moderationSource` is observability-only, so nothing
      // about the verdict, the timeout or the control flow changes when it stops being passed —
      // which is why every behavioural test in the repo stayed green while the label died. The
      // DECLARED value must arrive at `moderatePrompt`'s second parameter, per source, or the
      // `source` label collapses onto `other` in production.
      expect(
        mockModeratePrompt,
        `auditPromptServer({ moderationSource: '${source}' }) must call ` +
          `extModeration.moderatePrompt(<audited prompt>, '${source}'). Anything else — most likely ` +
          `the second argument being dropped or hardcoded at promptAuditing.ts's moderatePrompt ` +
          `call site — empties the '${source}' series on ` +
          `civitai_app_external_moderation_duration_seconds and files its calls under 'other'.`
      ).toHaveBeenCalledWith(AUDITED, source);
    }
  );

  it('carries a DIFFERENT declared source on each call, so no single hardcoded value can pass', async () => {
    // The `it.each` above resets mocks between cases, so a mutant hardcoding one member would fail
    // three of four rows but each in isolation. This case puts two sources in ONE mock history:
    // a constant in the source slot cannot produce both entries, whatever constant it is.
    await auditPromptServer({ ...baseOptions, moderationSource: 'generate' });
    await auditPromptServer({ ...baseOptions, moderationSource: 'preset' });

    const sourceArgs = mockModeratePrompt.mock.calls.map((c) => (c as unknown[])[1]);
    expect(
      sourceArgs,
      'two auditPromptServer calls declaring different sources must produce two different ' +
        "source arguments; a hardcoded or dropped label yields ['generate','generate'] or " +
        '[undefined, undefined] instead.'
    ).toEqual(['generate', 'preset']);
  });

  it('passes undefined — NOT a source — when the caller declares none, so the default stays with moderatePrompt', async () => {
    // The complement of the cases above, and the reason they are not enough on their own: the
    // default must be decided in ONE place (`moderatePrompt`'s `= 'other'` parameter default), so
    // an undeclared caller can never be labelled `generate`. A future "helpful" `?? 'generate'` at
    // the auditPromptServer call site would pass every assertion above and fail here.
    await auditPromptServer({ ...baseOptions });

    expect(
      mockModeratePrompt,
      'an options object declaring no moderationSource must hand moderatePrompt `undefined` and ' +
        'let its own parameter default decide (`other`), never a source picked at the call site.'
    ).toHaveBeenCalledWith(AUDITED, undefined);
  });
});
