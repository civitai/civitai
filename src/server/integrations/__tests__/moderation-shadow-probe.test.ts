/**
 * Contract for the external-moderation SHADOW PROBE.
 *
 * WHAT IT IS. A dark instrument that answers one question — "would a CHEAPER classifier model have
 * returned the same verdict?" — without ever acting on the answer. It runs on the generation
 * submission path, so like the cache probe beside it, most of these cases are negative constraints:
 * it must not change the verdict, must not add latency to the live call, must not be able to fail a
 * generation, must not contaminate the duration histogram, and must not exist at all until armed.
 *
 * 🔴 WHY THE TESTS LOOK LIKE THIS. The failure that matters is not "the rate is slightly off". It is
 * a probe that reports a reassuring agreement rate it did not measure — because it never ran, or
 * because it compared the wrong two things. Two cases below are the ones that would survive a green
 * suite if they were dropped, and each pins a claim the metric's own help text makes:
 *
 *   - `sends the CANDIDATE model on the PREPARED prompt` — drop it and the probe still records
 *     `match` for everything, because it would be comparing the incumbent against itself. A 100%
 *     agreement rate is exactly the result that gets acted on, and nothing else here contradicts it.
 *   - `splits the two divergence directions` — drop it and permissive/strict fold together, which is
 *     the one reading the counter exists to prevent: they cancel, so a candidate that is 2% more
 *     permissive AND 2% stricter is indistinguishable from one that agrees perfectly.
 *
 * Absence assertions are structured as DIFFERENTIALS, not bare zeros — the sibling probe's suite
 * learned that the hard way, when an "asserted zero" passed with the arming guard DELETED because a
 * lazy import simply had not resolved inside a fixed sleep. Every "records nothing" case here first
 * demonstrates that observations DO land in the same budget.
 *
 * These read back the REAL prom-client registry rather than asserting we called our own wrapper.
 */
import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock, overriding the global stub in src/__tests__/setup.ts, so each case can flip the
// arming inputs. `vi.hoisted` so it exists before the hoisted `vi.mock` factory references it.
const env = vi.hoisted(() => ({
  EXTERNAL_MODERATION_ENDPOINT: 'https://moderation.example/v1/moderations' as string,
  EXTERNAL_MODERATION_TOKEN: 'tok' as string,
  EXTERNAL_MODERATION_THRESHOLD: 0.5,
  EXTERNAL_MODERATION_TIMEOUT_MS: 5000,
  EXTERNAL_MODERATION_CATEGORIES: undefined as Record<string, string> | undefined,
  EXTERNAL_MODERATION_CACHE_PROBE: '' as string,
  EXTERNAL_MODERATION_CACHE_NAMESPACE: '' as string,
  EXTERNAL_MODERATION_CACHE_TTL_SECONDS: 0,
  EXTERNAL_MODERATION_SHADOW_MODEL: 'cheap-text-model' as string,
  EXTERNAL_MODERATION_SHADOW_SAMPLE: 1,
}));
vi.mock('~/env/server', () => ({ env }));

import { serverSchema } from '~/env/server-schema';
import { extModeration } from '~/server/integrations/moderation';
import {
  candidateVocabularyCovers,
  classifyShadowOutcome,
} from '~/server/integrations/moderation-shadow-probe';

const SHADOW = 'civitai_app_external_moderation_shadow_total';
const HIST = 'civitai_app_external_moderation_duration_seconds';

/** The model the live call always uses. Mirrors MODERATION_MODEL in moderation.ts. */
const INCUMBENT = 'omni-moderation-latest';

type Sample = { metricName?: string; labels: Record<string, string | number>; value: number };
type SentBody = { model: string; input: string };

async function samples(name: string): Promise<Sample[]> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  return (await metric.get()).values as Sample[];
}

async function shadowCount(outcome: string, source = 'generate') {
  const vals = await samples(SHADOW);
  return vals.find((v) => v.labels.outcome === outcome && v.labels.source === source)?.value ?? 0;
}

async function shadowTotal() {
  return (await samples(SHADOW)).reduce((acc, v) => acc + v.value, 0);
}

async function histTotal() {
  const vals = await samples(HIST);
  return vals
    .filter((v) => String(v.metricName ?? '').endsWith('_count'))
    .reduce((acc, v) => acc + v.value, 0);
}

function body(flagged: boolean) {
  return {
    results: [
      {
        flagged,
        categories: { violence: flagged },
        category_scores: { violence: flagged ? 0.9 : 0.1 },
      },
    ],
  };
}

/**
 * Stub `fetch` so the LIVE call and the SHADOW call can return DIFFERENT verdicts, keyed on the
 * `model` field of the request body. Returns the spy so a case can inspect what was actually sent.
 *
 * 🔴 This is what makes the fidelity case possible at all. With one canned response for every
 * request, a probe that shadowed the WRONG model — or never issued a second request and simply
 * compared the live verdict to itself — would record `match` and pass.
 */
function stubFetchByModel(verdicts: Record<string, boolean>) {
  const spy = vi.fn(async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as SentBody;
    const flagged = verdicts[parsed.model];
    if (flagged === undefined) throw new Error(`unexpected model ${parsed.model}`);
    return { ok: true, json: async () => body(flagged) };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The probe is fire-and-forget; poll rather than sleeping a fixed amount. */
async function untilShadowTotal(n: number) {
  await vi.waitFor(async () => expect(await shadowTotal()).toBe(n));
}

beforeEach(() => {
  promClient.register.getSingleMetric(SHADOW)?.reset();
  promClient.register.getSingleMetric(HIST)?.reset();
  env.EXTERNAL_MODERATION_SHADOW_MODEL = 'cheap-text-model';
  env.EXTERNAL_MODERATION_SHADOW_SAMPLE = 1;
  env.EXTERNAL_MODERATION_CATEGORIES = undefined;
  env.EXTERNAL_MODERATION_ENDPOINT = 'https://moderation.example/v1/moderations';
  // Deployment-identity knobs the arming guard reads. Reset per test: they are real process.env
  // entries, so a case that sets one would otherwise leak into every later case in this file.
  process.env.CACHE_KEY_NAMESPACE = '';
  delete process.env.IS_PREVIEW;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shadow probe — what it compares', () => {
  it('sends the CANDIDATE model, on the PREPARED prompt, as a SECOND request', async () => {
    // 🔴 THE FIDELITY CASE. Two independent things could be silently wrong and still yield a clean
    // 100% `match`: shadowing the incumbent model (comparing it against itself), or shadowing the
    // RAW prompt while the live call classified the PREPARED one (`removeFalsePositiveTriggers` is
    // many-to-one, so the two strings genuinely differ). Both would report perfect agreement, which
    // is the conclusion that gets acted on.
    const fetchSpy = stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });

    // 'girl' is rewritten to 'woman' by removeFalsePositiveTriggers, so the prepared string is
    // observably different from the input.
    await extModeration.moderatePrompt('a girl in a school uniform', 'generate');
    await untilShadowTotal(1);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const sent = fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body) as SentBody);
    const live = sent.find((s) => s.model === INCUMBENT);
    const shadow = sent.find((s) => s.model === 'cheap-text-model');

    // Asserted as a pair so a missing shadow request fails HERE with a readable message, rather
    // than as a TypeError on the next line.
    expect([live?.model, shadow?.model]).toEqual([INCUMBENT, 'cheap-text-model']);
    // Literal expected value, not derived from the implementation: 'girl'->'woman' and
    // 'school uniform'->'uniform'.
    expect(shadow?.input).toBe('a woman in a uniform');
    // Both models must see the SAME string, or the comparison measures the substitution.
    expect(shadow?.input).toBe(live?.input);
  });

  it('splits the two divergence directions into distinct outcomes', async () => {
    // 🔴 THE DESIGN CASE. permissive and strict must never share a label: folded together they
    // cancel. Both legs run here so a mutant that collapses them fails on one of the two.
    stubFetchByModel({ [INCUMBENT]: true, 'cheap-text-model': false });
    await extModeration.moderatePrompt('incumbent flags this one', 'generate');
    await untilShadowTotal(1);
    expect(await shadowCount('candidate_permissive')).toBe(1);
    expect(await shadowCount('candidate_strict')).toBe(0);
    expect(await shadowCount('match')).toBe(0);

    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': true });
    await extModeration.moderatePrompt('only the candidate flags this one', 'generate');
    await untilShadowTotal(2);
    expect(await shadowCount('candidate_strict')).toBe(1);
    // The permissive count must NOT have moved — that is what "distinct" means.
    expect(await shadowCount('candidate_permissive')).toBe(1);
  });

  it('records `match` when the two models agree, in both directions', async () => {
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('both agree this is fine', 'generate');
    await untilShadowTotal(1);

    stubFetchByModel({ [INCUMBENT]: true, 'cheap-text-model': true });
    await extModeration.moderatePrompt('both agree this is not', 'generate');
    await untilShadowTotal(2);

    expect(await shadowCount('match')).toBe(2);
    expect(await shadowCount('candidate_permissive')).toBe(0);
    expect(await shadowCount('candidate_strict')).toBe(0);
  });
});

describe('shadow probe — vocabulary gate (audit round 1, F1)', () => {
  // 🔴 PRODUCTION'S REAL CONFIGURATION. Read live from the dp-prod ConfigMap 2026-09-07:
  // EXTERNAL_MODERATION_CATEGORIES = 'sexual/minors:inappropriate minor content'. A SINGLE key, so
  // the app's verdict is exactly `Boolean(result.categories['sexual/minors'])`.
  const PROD_MAP = { 'sexual/minors': 'inappropriate minor content' };

  /** A response in a DIFFERENT vocabulary: same meaning, different category names. */
  function bodyForeignVocab(flagged: boolean) {
    return {
      results: [
        {
          flagged,
          categories: { csam: flagged, adult: false },
          category_scores: { csam: flagged ? 0.95 : 0.02, adult: 0.1 },
        },
      ],
    };
  }

  it('records `incomparable` — NOT a false disagreement — when the candidate lacks the mapped key', async () => {
    // 🔴 THE FINDING THIS TEST EXISTS FOR. Without the gate, a candidate in PERFECT agreement that
    // simply names the category differently yields Boolean(undefined) === false on every call, so
    // every incumbent flag books as `candidate_permissive` at ZERO errors. A blind candidate reads
    // IDENTICALLY. That is a fully plausible number, unrelated to quality, on a fail-closed gate.
    env.EXTERNAL_MODERATION_CATEGORIES = PROD_MAP;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const parsed = JSON.parse(init.body) as SentBody;
        if (parsed.model === INCUMBENT) {
          // The incumbent DOES flag, in its own vocabulary.
          return {
            ok: true,
            json: async () => ({
              results: [
                {
                  flagged: true,
                  categories: { 'sexual/minors': true },
                  category_scores: { 'sexual/minors': 0.95 },
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => bodyForeignVocab(true) };
      })
    );

    const verdict = await extModeration.moderatePrompt('a prompt the incumbent flags', 'generate');
    await untilShadowTotal(1);

    expect(verdict.flagged).toBe(true); // the gate itself is untouched
    expect(await shadowCount('incomparable')).toBe(1);
    // The whole point: it must NOT be booked as the candidate being permissive.
    expect(await shadowCount('candidate_permissive')).toBe(0);
    expect(await shadowCount('match')).toBe(0);
  });

  it('still compares normally when the candidate DOES share the mapped vocabulary', async () => {
    // The gate must not simply switch the probe off under a category map — that would trade a
    // wrong number for no number, and production always runs a map.
    env.EXTERNAL_MODERATION_CATEGORIES = PROD_MAP;
    const shared = (flagged: boolean) => ({
      results: [
        {
          flagged,
          categories: { 'sexual/minors': flagged },
          category_scores: { 'sexual/minors': flagged ? 0.95 : 0.01 },
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const parsed = JSON.parse(init.body) as SentBody;
        return { ok: true, json: async () => shared(parsed.model === INCUMBENT) };
      })
    );

    await extModeration.moderatePrompt('incumbent flags, candidate does not', 'generate');
    await untilShadowTotal(1);
    expect(await shadowCount('candidate_permissive')).toBe(1);
    expect(await shadowCount('incomparable')).toBe(0);
  });

  it('does not gate in THRESHOLD mode, where the vendor`s own flagged is comparable', async () => {
    env.EXTERNAL_MODERATION_CATEGORIES = undefined;
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilShadowTotal(1);
    expect(await shadowCount('match')).toBe(1);
    expect(await shadowCount('incomparable')).toBe(0);
  });

  it('coverage is by OWN property, so a prototype key cannot fake it', () => {
    // `in` walks the prototype chain, so `'toString' in {}` is true and the vocabulary would read
    // as covered on a response carrying nothing of the sort.
    expect(candidateVocabularyCovers({ categories: {} }, { toString: 'x' })).toBe(false);
    expect(candidateVocabularyCovers({ categories: { toString: true } }, { toString: 'x' })).toBe(
      true
    );
  });

  it('treats a missing or non-object categories field as not covered', () => {
    expect(candidateVocabularyCovers({}, PROD_MAP)).toBe(false);
    expect(candidateVocabularyCovers({ categories: null }, PROD_MAP)).toBe(false);
    expect(candidateVocabularyCovers({ categories: 'nope' }, PROD_MAP)).toBe(false);
    // Threshold mode: no map, nothing to cover.
    expect(candidateVocabularyCovers({}, undefined)).toBe(true);
  });

  it('is DETERMINACY, not coverage: a present TRUE key settles the verdict despite a missing one', () => {
    // 🔴 ROUND 2, F2. `deriveModerationVerdict` ORs across mapped keys, so one present `true` fixes
    // the verdict at `flagged: true` whatever the missing key would have said — that comparison is
    // makeable and must not be thrown away as `incomparable`. Unreachable on production's
    // single-key map; reachable the moment a second category is configured, which needs no code.
    const twoKeys = { 'sexual/minors': 'a', violence: 'b' };
    expect(candidateVocabularyCovers({ categories: { 'sexual/minors': true } }, twoKeys)).toBe(
      true
    );
  });

  it('is INDETERMINATE when nothing present is true and a mapped key is missing', () => {
    // Here the verdict really is unknowable: the absent key might have been the one that flagged.
    const twoKeys = { 'sexual/minors': 'a', violence: 'b' };
    expect(candidateVocabularyCovers({ categories: { 'sexual/minors': false } }, twoKeys)).toBe(
      false
    );
    // All keys present and all false — determinate `flagged: false`, so comparable.
    expect(
      candidateVocabularyCovers(
        { categories: { 'sexual/minors': false, violence: false } },
        twoKeys
      )
    ).toBe(true);
  });
});

describe('shadow probe — arming', () => {
  it('REFUSES to arm in a PR preview (CACHE_KEY_NAMESPACE=preview)', async () => {
    // Round 1 F2: the preview deploy task copies civitai-cfg from staging and rewrites an
    // enumerated key list that cannot name fields which did not exist when it was written, so
    // arming on staging would otherwise arm every open preview, each spending the production
    // credential unattributed. Differential: prove observations land in this budget first.
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilShadowTotal(1);

    process.env.CACHE_KEY_NAMESPACE = 'preview';
    const fetchSpy = stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));

    expect(await shadowTotal()).toBe(1);
    // Refusing to arm must also mean refusing to SPEND: one request, the live one.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('🔴 STILL ARMS on the standing non-production deployment (round 2, F1)', async () => {
    // 🔴 THE ROUND-2 REGRESSION, PINNED. The first version of this guard used IS_PREVIEW, and
    // `civitai-next` — the standing non-production deployment, and the config SOURCE the previews
    // copy from — sets IS_PREVIEW=true itself. So the guard refused the one staging rehearsal it
    // claimed to protect and left production as the practical arming target. Its namespace is
    // `next`, so gating on the namespace permits it, which is the whole point of the correction.
    process.env.CACHE_KEY_NAMESPACE = 'next';
    process.env.IS_PREVIEW = 'true'; // exactly what that deployment carries
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a staging rehearsal', 'generate');
    await untilShadowTotal(1);
    expect(await shadowCount('match')).toBe(1);
  });

  it('arms in production, where the namespace is empty and IS_PREVIEW is unset', async () => {
    process.env.CACHE_KEY_NAMESPACE = '';
    delete process.env.IS_PREVIEW;
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a production call', 'generate');
    await untilShadowTotal(1);
    expect(await shadowCount('match')).toBe(1);
  });

  it('refuses on the TRANSITIONAL preview: namespace unset but IS_PREVIEW=true', async () => {
    // cache-key-prefix.ts:66-75 warns this state exists. An unset namespace must not fail OPEN.
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilShadowTotal(1);

    process.env.CACHE_KEY_NAMESPACE = '';
    process.env.IS_PREVIEW = 'true';
    const fetchSpy = stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));
    expect(await shadowTotal()).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is OFF when the model is unset, even with a positive sample', async () => {
    // Differential: prove observations land in this budget first, so the absence is evidence.
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilShadowTotal(1);

    env.EXTERNAL_MODERATION_SHADOW_MODEL = '';
    const fetchSpy = stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));

    expect(await shadowTotal()).toBe(1);
    // Not armed must also mean not SPENDING: exactly one request, the live one.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is OFF when the sample rate is zero, even with a model named', async () => {
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilShadowTotal(1);

    env.EXTERNAL_MODERATION_SHADOW_SAMPLE = 0;
    const fetchSpy = stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));

    expect(await shadowTotal()).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is OFF when the sample rate is NaN — the one case the arming guard uniquely catches', async () => {
    // 🔴 THIS CASE EXISTS BECAUSE THE `sample > 0` ARMING GUARD IS OTHERWISE REDUNDANT, and a
    // redundant guard is an untested one. For sample=0 the later `Math.random() >= sample` check
    // already returns (every random is >= 0), so deleting the arming guard leaves that test green —
    // it dies to the OTHER guard. NaN is the case only the arming guard catches: `Math.random() >=
    // NaN` is FALSE, so without it the probe would sail through and issue a billable request with a
    // nonsense sample. Written as `!(sample > 0)` rather than `sample <= 0` for exactly this reason.
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilShadowTotal(1);

    env.EXTERNAL_MODERATION_SHADOW_SAMPLE = Number.NaN;
    const fetchSpy = stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));

    expect(await shadowTotal()).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a whitespace-only model name as unset rather than arming on it', async () => {
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilShadowTotal(1);

    env.EXTERNAL_MODERATION_SHADOW_MODEL = '   ';
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));
    expect(await shadowTotal()).toBe(1);
  });
});

describe('shadow probe — it cannot harm the live path', () => {
  it('returns the INCUMBENT verdict even when the candidate disagrees', async () => {
    // The gate must be unaffected. The candidate says "fine", the incumbent says "flagged"; the
    // caller must still see flagged.
    stubFetchByModel({ [INCUMBENT]: true, 'cheap-text-model': false });
    const verdict = await extModeration.moderatePrompt('incumbent flags this', 'generate');
    await untilShadowTotal(1);

    expect(verdict.flagged).toBe(true);
    expect(await shadowCount('candidate_permissive')).toBe(1);
  });

  it('records `error` and still returns the live verdict when the shadow request fails', async () => {
    const spy = vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as SentBody;
      if (parsed.model !== INCUMBENT) throw new Error('shadow gateway is down');
      return { ok: true, json: async () => body(false) };
    });
    vi.stubGlobal('fetch', spy);

    const verdict = await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilShadowTotal(1);

    expect(verdict.flagged).toBe(false);
    expect(await shadowCount('error')).toBe(1);
  });

  it('does NOT observe the shadow request on the duration histogram', async () => {
    // 🔴 The histogram measures what ONE classifier call costs. A second in-flight request counted
    // there would drag every quantile and corrupt the instrument the latency case rests on.
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilShadowTotal(1);

    expect(await histTotal()).toBe(1);
  });

  it('clamps an out-of-set source, so no caller can mint a label value', async () => {
    stubFetchByModel({ [INCUMBENT]: false, 'cheap-text-model': false });
    await extModeration.moderatePrompt('a serene landscape', 'not-a-real-source' as never);
    await untilShadowTotal(1);

    expect(await shadowCount('match', 'other')).toBe(1);
  });
});

describe('shadow probe — outcome classification is pure and total', () => {
  // Direct unit coverage so the mapping is pinned independently of the HTTP path.
  it('maps the four cases by literal expectation', () => {
    expect(classifyShadowOutcome({ flagged: false }, { flagged: false })).toBe('match');
    expect(classifyShadowOutcome({ flagged: true }, { flagged: true })).toBe('match');
    expect(classifyShadowOutcome({ flagged: true }, { flagged: false })).toBe(
      'candidate_permissive'
    );
    expect(classifyShadowOutcome({ flagged: false }, { flagged: true })).toBe('candidate_strict');
  });

  it('coerces a truthy non-boolean rather than reporting a false disagreement', () => {
    // `flagged` comes off an untyped res.json(); a vendor sending 1 and true must not read as a
    // disagreement between two verdicts that both mean "flagged".
    expect(classifyShadowOutcome({ flagged: 1 as never }, { flagged: true })).toBe('match');
    expect(classifyShadowOutcome({ flagged: 0 as never }, { flagged: false })).toBe('match');
  });
});

describe('shadow probe — env schema bounds', () => {
  const field = (name: keyof typeof serverSchema.shape) => serverSchema.shape[name];

  it('degrades an unparseable sample rate to OFF rather than throwing', () => {
    // `src/env/server.ts` THROWS on an invalid field and env is parsed only at container start, so
    // a typo must not be able to CrashLoop the fleet at the next rollout.
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse('off')).toBe(0);
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse('50%')).toBe(0);
    // Out of range in either direction also lands on OFF, not on a clamped value.
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse('2')).toBe(0);
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse('-1')).toBe(0);
  });

  it('accepts a fraction in range', () => {
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse('0.05')).toBe(0.05);
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse('1')).toBe(1);
  });

  it('defaults both inputs to OFF when absent', () => {
    expect(field('EXTERNAL_MODERATION_SHADOW_MODEL').parse(undefined)).toBe('');
    expect(field('EXTERNAL_MODERATION_SHADOW_SAMPLE').parse(undefined)).toBe(0);
  });
});
