import type { SearchParams } from 'meilisearch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as JevModule from '~/server/services/ai/jev';
import type * as FliptModule from '~/server/flipt/client';
import type {
  ResourceIntentAnswer,
  ResourceIntentCriteria,
  ResourceIntentRole,
} from '~/server/schema/resource-intent.schema';

/**
 * The M3 retrieval comparison: the metric math (every expectation a literal computed
 * independently of this code — McNemar by exact rational arithmetic), the verdict
 * mapping, the
 * two-arm runner over a small in-memory index (the fake-index pattern of
 * `src/server/services/__tests__/resource-intent-matcher.seed.test.ts`), and the CLI
 * gate in `main()`.
 */

const searchWithSignal = vi.fn();
const meiliHolder: { client: unknown } = { client: { index: () => ({}) } };

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  get searchClient() {
    return meiliHolder.client;
  },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));

const askJev = vi.fn();
// Feature-flag evaluation for the coverage guard. `null` = could not be evaluated (what
// `isFliptSync` returns when Flipt is unreachable); a boolean = a real evaluation.
// `flagTable` is the live flag state both readers see; `fliptSync` is the `isFliptSync`
// reader alone (so a test can see which entity ids the GUARD asked for, separately from
// the ones `coverageAudience` asks `isFlipt` for).
const flagTable = vi.fn<(flag: string, entityId?: string) => boolean | null>(() => false);
const fliptSync = vi.fn<(flag: string, entityId?: string) => boolean | null>((flag, entityId) =>
  flagTable(flag, entityId)
);
const fliptClient = { close: vi.fn() };
const fliptClientHolder: { current: typeof fliptClient | null } = { current: fliptClient };
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptModule>()),
  ensureFliptInitialized: async () => undefined,
  getFliptClientSync: () => fliptClientHolder.current,
  isFliptSync: (flag: string, entityId?: string) => fliptSync(flag, entityId),
  isFlipt: async (flag: string, entityId?: string) => flagTable(flag, entityId) === true,
}));

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => askJev(...args),
}));

const retrievalModule = await import('../eval-resource-intent-retrieval');
const {
  countLabeledIndexDocuments,
  evaluateRetrieval,
  exactMcNemarP,
  hitAtK,
  inRoleGold,
  loadLabeledModelIds,
  popularityArm,
  purposeBeatsPopularity,
  rankedModelIds,
  reciprocalRankAtK,
  renderRetrievalReport,
  retrievalVerdict,
  requestBaseModel,
  runRetrievalArms,
} = retrievalModule;
const registrationModule = await import('../eval-resource-intent-registration');
const {
  M3_RETRIEVAL_PREREGISTRATION,
  PREREGISTERED_RUN_PARAMS,
  preregistrationOverrides,
  renderRetrievalPreregistration,
} = registrationModule;
const goldsetModule = await import('../eval-resource-intent-goldset');
const executeModule = await import('../eval-resource-intent-goldset-execute');
type Outcome = Awaited<ReturnType<typeof runRetrievalArms>>[number];
type GoldRow = Parameters<typeof runRetrievalArms>[0][number];
const { buildResourceIntentFilter } = await import(
  '~/server/services/resource-intent-matcher.service'
);
const { buildResourceIntentStage1Request, compileCriteria } = await import(
  '~/server/services/resource-intent-stage1'
);
const { ROLE_MODEL_TYPES } = await import('~/server/schema/resource-intent.schema');
const { allBrowsingLevelsFlag } = await import('~/shared/constants/browsingLevel.constants');
const { Flags } = await import('~/shared/utils/flags');

// ---------------------------------------------------------------------------
// Metric math
// ---------------------------------------------------------------------------

describe('rankedModelIds / hitAtK / reciprocalRankAtK', () => {
  it('ranks DISTINCT model ids in shortlist order', () => {
    expect(rankedModelIds([5, 5, 7, 3, 7].map((modelId) => ({ modelId })))).toEqual([5, 7, 3]);
  });

  it('hit@K counts exactly the first K ids — the Kth is in, the (K+1)th is out', () => {
    const ranked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(hitAtK(ranked, new Set([10]), 10)).toBe(true);
    expect(hitAtK(ranked, new Set([10]), 9)).toBe(false);
    expect(hitAtK(ranked, new Set([11]), 10)).toBe(false);
    expect(hitAtK(ranked, new Set([99]), 50)).toBe(false);
    expect(hitAtK(ranked, new Set([99, 3]), 3)).toBe(true);
  });

  it('MRR@K is 1 / the rank of the FIRST gold id within K, else 0', () => {
    const ranked = [4, 8, 15, 16];
    expect(reciprocalRankAtK(ranked, new Set([15]), 4)).toBe(1 / 3);
    expect(reciprocalRankAtK(ranked, new Set([15]), 3)).toBe(1 / 3);
    expect(reciprocalRankAtK(ranked, new Set([15]), 2)).toBe(0);
    expect(reciprocalRankAtK(ranked, new Set([16, 4]), 4)).toBe(1);
    expect(reciprocalRankAtK(ranked, new Set([42]), 4)).toBe(0);
  });
});

describe('exactMcNemarP — exact two-sided binomial on the discordant pairs', () => {
  it.each([
    [0, 5, 0.0625],
    [1, 9, 0.021484375],
    [9, 1, 0.021484375],
    [2, 8, 0.109375],
    [5, 5, 1],
    [0, 0, 1],
    [3, 0, 0.25],
  ])('b=%i c=%i → p=%f (exact)', (b, c, p) => {
    expect(exactMcNemarP(b, c)).toBeCloseTo(p, 12);
  });

  it('stays exact at larger n, where a naive 0.5^n would underflow', () => {
    expect(exactMcNemarP(30, 60)).toBeCloseTo(0.002060265680963076, 12);
    expect(exactMcNemarP(40, 60)).toBeCloseTo(0.05688793364098079, 12);
    expect(exactMcNemarP(600, 700)).toBeCloseTo(0.0060157938610449525, 12);
  });
});

describe('purposeBeatsPopularity — the pre-registered decision rule: b > c AND exact McNemar p < 0.05', () => {
  it.each([
    [12, 0, true], // p = 2/4096
    [9, 1, true], // p = 0.0215
    [8, 2, false], // b > c, p = 0.109
    [3, 0, false], // b > c, p = 0.25
    [5, 5, false], // tie
    [1, 9, false], // p < 0.05 but c > b
    [0, 12, false], // a significant loss
    [0, 0, false],
  ])('b=%i c=%i → %s', (b, c, expected) => {
    expect(M3_RETRIEVAL_PREREGISTRATION.alpha).toBe(0.05);
    expect(purposeBeatsPopularity(b, c)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Pre-registration
// ---------------------------------------------------------------------------

describe('the pre-registration', () => {
  it('pins the registered values', () => {
    expect(PREREGISTERED_RUN_PARAMS).toEqual({ sampleSize: 1000, sampleDays: 30 });
    expect(M3_RETRIEVAL_PREREGISTRATION).toMatchObject({
      version: 2,
      registeredOn: '2026-10-06',
      primaryK: 10,
      secondaryK: 50,
      alpha: 0.05,
      cap: 50,
      labeledIndexFloor: 100,
      powerAssumption: { discordantRate: 0.15, scoredFraction: 0.667 },
      voidIf: { minScored: 667, maxInfraExclusionFraction: 0.1 },
      pilotSampleSize: 100,
    });
    expect(M3_RETRIEVAL_PREREGISTRATION).not.toHaveProperty('bootstrapSeed');
  });

  it('reports every override, and none for the registered run', () => {
    expect(preregistrationOverrides(PREREGISTERED_RUN_PARAMS)).toEqual([]);
    expect(
      preregistrationOverrides({ ...PREREGISTERED_RUN_PARAMS, sampleSize: 100, sampleDays: 7 })
    ).toEqual(['sampleSize: 1000 -> 100', 'sampleDays: 30 -> 7']);
  });

  it('🔴 states the decision rule and all three verdicts, NOT MET included, in full', () => {
    const text = renderRetrievalPreregistration();
    for (const block of [
      [
        'Decision rule: PURPOSE beats POPULARITY iff b > c AND the exact two-sided McNemar p',
        'on (b, c) is < 0.05.',
      ],
      [
        'Verdict on the closing clause — every run reports exactly one:',
        '  MET     — the decision rule holds.',
        '  NOT MET — it does not. The closing clause is judged not met and the question is',
        '            closed as not delivered. Any follow-up (better gold, new labels) is new',
        '            work under a new registration, not a re-run of this one.',
        '  VOID    — no verdict on the clause, if ANY of: a registered value was overridden',
        '            (including the 100-prompt pilot); fewer than 667 prompts scored (the n the',
        '            power calculation assumes); infrastructure exclusions (stage-1 failure,',
        '            arm error, label-read fallback) exceed 10% of drawn prompts; or both',
        '            arms returned the same first 10 model ids on every scored prompt. Two',
        '            checks abort before any index read or vendor call, so they produce no',
        '            report at all: coverage flags not evaluated by a live Flipt client (Flipt',
        '            unreachable, a flag missing, or a coverage flag set in',
        '            FLIPT_LOCAL_OVERRIDES — any of which is not the endpoint), and a failed',
        '            positive control.',
      ],
      [
        'Known confound: people attach popular models, so attached-resource gold is biased',
        'TOWARD the POPULARITY arm. A MET verdict is therefore conservative. A NOT MET verdict',
        'stands as the verdict on the closing clause; what the confound limits is only the',
        'reading of WHY it was not met — the gold measures retrieval of what people attached,',
        'not the labels themselves — which the labeled/unlabeled breakdown is reported to',
        'inform.',
      ],
      [
        'Power assumption (measured by the pilot first): >= 66.7% of drawn prompts score, and the',
        'arms are discordant at hit@10 on >= 15.0% of scored prompts.',
      ],
    ]) {
      expect(text).toContain(block.join('\n'));
    }
    expect(text).not.toMatch(/bootstrap|not by itself evidence/);
  });
});

describe('parseRetrievalParams — CLI overrides', () => {
  it('defaults to the registered values', () => {
    expect(goldsetModule.parseRetrievalParams({})).toEqual(PREREGISTERED_RUN_PARAMS);
  });

  it('accepts the two overridable flags', () => {
    expect(goldsetModule.parseRetrievalParams({ 'retrieval-sample': '100', days: '7' })).toEqual({
      sampleSize: 100,
      sampleDays: 7,
    });
  });

  it.each(['ten', '10abc', '1e3', '5.5', '0', '-5', ''])(
    'refuses %j instead of silently using another value',
    (raw) => {
      expect(() => goldsetModule.parseRetrievalParams({ 'retrieval-sample': raw })).toThrow(
        '--retrieval-sample must be a positive integer'
      );
    }
  );
});

describe('part one report — stage-1 skips are counted, not silent', () => {
  it('states judged and skipped rows against the drawn count', () => {
    const evaluation = goldsetModule.evaluateGoldset([
      {
        row: { imageId: 1, prompt: 'p', attachedTypes: ['LORA'], attachedBaseModels: ['Pony'] },
        judgment: intentFor('style'),
      },
    ]);
    expect(goldsetModule.renderGoldsetReport(evaluation, { drawn: 3 })).toContain(
      'Judged 1 of 3 drawn rows; 2 skipped on a stage-1 failure.'
    );
    expect(goldsetModule.renderGoldsetReport(evaluation)).not.toContain('Judged');
  });
});

describe('the gold-set SQL — the WHOLE query text, pinned', () => {
  // Pinned as one whitespace-normalised string, not as a list of words: a word list
  // passed with `AND i.poi = false` turned into `OR i.poi = false`, with a predicate
  // OR'd to true, and with the sample's `ORDER BY rnd` deleted. Any edit to these
  // queries now has to edit this text too, which is the point — they decide whose prompt
  // reaches the vendor. Behaviour was checked against a real Postgres when written.
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  it('🔴 the matched query: eligibility, the sample-first CTE in random order, the gold', () => {
    expect(norm(registrationModule.GOLDSET_MATCHED_SQL(30, 10).sql)).toBe(
      'WITH sampled AS ( SELECT i.id, i.meta->>\'prompt\' AS prompt, random() AS rnd FROM "Image" i JOIN "Post" p ON p.id = i."postId" WHERE i."createdAt" > now() - make_interval(days => ?::int) AND i."hideMeta" = false AND length(i.meta->>\'prompt\') > 0 AND i.ingestion = \'Scanned\' AND i."tosViolation" = false AND i."needsReview" IS NULL AND i."blockedFor" IS NULL AND i.minor = false AND i.poi = false AND p."publishedAt" IS NOT NULL AND p."publishedAt" <= now() AND p.availability != \'Private\'::"Availability" AND p.availability != \'Unsearchable\'::"Availability" AND NOT EXISTS ( SELECT 1 FROM "ImageResourceNew" fr JOIN "ModelVersion" fmv ON fmv.id = fr."modelVersionId" JOIN "Model" fm ON fm.id = fmv."modelId" WHERE fr."imageId" = i.id AND (fm.poi OR fm.minor) ) AND EXISTS (SELECT 1 FROM "ImageResourceNew" r WHERE r."imageId" = i.id) ORDER BY rnd LIMIT ?::int ) SELECT s.id AS "imageId", s.prompt, array_agg(DISTINCT m.type::text) AS "attachedTypes", array_agg(DISTINCT mv."baseModel") AS "attachedBaseModels", jsonb_agg(DISTINCT jsonb_build_object(\'modelId\', m.id, \'modelType\', m.type::text)) AS "attachedModels", COALESCE( array_agg(DISTINCT mv."baseModel") FILTER (WHERE m.type = \'Checkpoint\'), ARRAY[]::text[] ) AS "checkpointBaseModels" FROM sampled s JOIN "ImageResourceNew" irn ON irn."imageId" = s.id JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId" JOIN "Model" m ON m.id = mv."modelId" GROUP BY s.id, s.prompt, s.rnd ORDER BY s.rnd'
    );
  });

  it('🔴 the unmatched query: the same eligibility, no attachments', () => {
    expect(norm(registrationModule.GOLDSET_UNMATCHED_SQL(30, 10).sql)).toBe(
      'SELECT i.id AS "imageId", i.meta->>\'prompt\' AS prompt, ARRAY[]::text[] AS "attachedTypes", ARRAY[]::text[] AS "attachedBaseModels" FROM "Image" i JOIN "Post" p ON p.id = i."postId" WHERE i."createdAt" > now() - make_interval(days => ?::int) AND i."hideMeta" = false AND length(i.meta->>\'prompt\') > 0 AND i.ingestion = \'Scanned\' AND i."tosViolation" = false AND i."needsReview" IS NULL AND i."blockedFor" IS NULL AND i.minor = false AND i.poi = false AND p."publishedAt" IS NOT NULL AND p."publishedAt" <= now() AND p.availability != \'Private\'::"Availability" AND p.availability != \'Unsearchable\'::"Availability" AND NOT EXISTS ( SELECT 1 FROM "ImageResourceNew" fr JOIN "ModelVersion" fmv ON fmv.id = fr."modelVersionId" JOIN "Model" fm ON fm.id = fmv."modelId" WHERE fr."imageId" = i.id AND (fm.poi OR fm.minor) ) AND NOT EXISTS (SELECT 1 FROM "ImageResourceNew" irn WHERE irn."imageId" = i.id) ORDER BY random() LIMIT ?::int'
    );
  });
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const scoredOutcome = (
  imageId: number,
  over: Partial<Extract<Outcome, { status: 'scored' }>>
): Outcome => ({
  imageId,
  status: 'scored',
  role: 'style',
  baseModel: 'Pony',
  attachedCount: 2,
  checkpointCount: 1,
  inRoleCount: 1,
  goldModelIds: [100],
  goldLabeled: false,
  purposeModelIds: [],
  popularityModelIds: [],
  ...over,
});

/** `length` distinct filler ids with `id` placed at 1-based `rank` (null ⇒ absent). */
const rankedWith = (id: number | null, rank: number, length = 60) =>
  Array.from({ length }, (_, i) => (id !== null && i === rank - 1 ? id : 1000 + i));

describe('evaluateRetrieval', () => {
  const outcomes: Outcome[] = [
    // P hit@10, Q miss (Q has it at 12) — discordant b; labeled
    scoredOutcome(1, {
      purposeModelIds: rankedWith(100, 1),
      popularityModelIds: rankedWith(100, 12),
      goldLabeled: true,
    }),
    // P hit, Q miss — b
    scoredOutcome(2, {
      purposeModelIds: rankedWith(100, 3),
      popularityModelIds: rankedWith(null, 1),
    }),
    // Q hit, P miss — c; labeled
    scoredOutcome(3, {
      purposeModelIds: rankedWith(null, 1),
      popularityModelIds: rankedWith(100, 2),
      goldLabeled: true,
    }),
    // both hit, identical lists
    scoredOutcome(4, {
      purposeModelIds: rankedWith(100, 5),
      popularityModelIds: rankedWith(100, 5),
    }),
    {
      imageId: 5,
      status: 'role_none',
      role: 'none',
      attachedCount: 1,
      checkpointCount: 1,
      inRoleCount: 0,
    },
    {
      imageId: 6,
      status: 'no_in_role_attachment',
      role: 'style',
      attachedCount: 3,
      checkpointCount: 1,
      inRoleCount: 0,
    },
    {
      imageId: 7,
      status: 'stage1_failed',
      role: null,
      attachedCount: 2,
      checkpointCount: 1,
      inRoleCount: 0,
    },
    {
      imageId: 8,
      status: 'arm_error',
      role: 'clothing',
      attachedCount: 2,
      checkpointCount: 0,
      inRoleCount: 2,
    },
    {
      imageId: 9,
      status: 'insight_fallback',
      role: 'style',
      attachedCount: 4,
      checkpointCount: 1,
      inRoleCount: 1,
    },
  ];

  it('counts exclusions, the out-of-role share and the discordant pairs', () => {
    const e = evaluateRetrieval(outcomes);
    expect(e.drawn).toBe(9);
    expect(e.excluded).toEqual({
      stage1_failed: 1,
      role_none: 1,
      no_in_role_attachment: 1,
      arm_error: 1,
      insight_fallback: 1,
    });
    // Rows with a non-none role: 1-4 (2 attached, 1 in role, 1 checkpoint each),
    // 6 (3/0/1), 8 (2/2/0), 9 (4/1/1).
    expect(e.outOfRole).toEqual({ attached: 17, excluded: 10, checkpoints: 6 });
    expect(e.primary).toMatchObject({ n: 4, purposeHits: 3, popularityHits: 2, b: 2, c: 1 });
    expect(e.primary.difference).toBe(0.25);
    expect(e.primary.mcnemarP).toBe(1);
    expect(e.primary.purposeBeatsPopularity).toBe(false); // b > c, but p = 1
    expect(e.identicalAtPrimaryK).toBe(1);
    // 3 infrastructure exclusions of 9 drawn: the run is too degraded to judge.
    expect(e.verdict).toEqual({
      verdict: 'VOID',
      reason: 'infrastructure exclusions 3 of 9 drawn exceed 10%',
    });
  });

  it('scores the secondary K and MRR on the same rows', () => {
    const e = evaluateRetrieval(outcomes);
    // At 50 the popularity arm also finds row 1's gold (rank 12).
    expect(e.secondary.k).toBe(50);
    expect(e.secondary.hit).toMatchObject({ purposeHits: 3, popularityHits: 3, b: 1, c: 1 });
    // MRR: P = (1 + 1/3 + 0 + 1/5) / 4; Q = (1/12 + 0 + 1/2 + 1/5) / 4.
    expect(e.secondary.purposeMrr).toBeCloseTo((1 + 1 / 3 + 1 / 5) / 4, 12);
    expect(e.secondary.popularityMrr).toBeCloseTo((1 / 12 + 1 / 2 + 1 / 5) / 4, 12);
  });

  it('the secondary cutoff is 50 exactly — rank 50 counts, rank 51 does not', () => {
    const e = evaluateRetrieval([
      scoredOutcome(1, {
        purposeModelIds: rankedWith(100, 50),
        popularityModelIds: rankedWith(100, 51),
      }),
    ]);
    expect(e.secondary.hit).toMatchObject({ purposeHits: 1, popularityHits: 0, b: 1, c: 0 });
    expect(e.secondary.purposeMrr).toBeCloseTo(1 / 50, 12);
    expect(e.secondary.popularityMrr).toBe(0);
  });

  it('stratifies by whether the gold carries a label', () => {
    const e = evaluateRetrieval(outcomes);
    expect(e.strata.labeled).toMatchObject({ n: 2, b: 1, c: 1 });
    expect(e.strata.unlabeled).toMatchObject({ n: 2, b: 1, c: 0 });
  });

  it('counts arms as identical on the first K ONLY', () => {
    const sameHead = scoredOutcome(1, {
      purposeModelIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      popularityModelIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99],
    });
    const differsAtTen = scoredOutcome(2, {
      purposeModelIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      popularityModelIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 77],
    });
    expect(evaluateRetrieval([sameHead, differsAtTen]).identicalAtPrimaryK).toBe(1);
  });

  it('declares a win only when the rule holds', () => {
    const wins = Array.from({ length: 12 }, (_, i) =>
      scoredOutcome(i + 1, {
        purposeModelIds: rankedWith(100, 1),
        popularityModelIds: rankedWith(null, 1),
      })
    );
    const e = evaluateRetrieval(wins);
    expect(e.primary).toMatchObject({ b: 12, c: 0 });
    expect(e.primary.mcnemarP).toBeCloseTo(2 / 4096, 12);
    expect(e.primary.purposeBeatsPopularity).toBe(true);
    // The rule holds, but 12 scored is under the registered minimum: VOID, not MET.
    expect(e.verdict.verdict).toBe('VOID');
  });

  it('a SIGNIFICANT PURPOSE loss is not a win', () => {
    const losses = Array.from({ length: 12 }, (_, i) =>
      scoredOutcome(i + 1, {
        purposeModelIds: rankedWith(null, 1),
        popularityModelIds: rankedWith(100, 1),
      })
    );
    const e = evaluateRetrieval(losses);
    expect(e.primary).toMatchObject({ b: 0, c: 12 });
    expect(e.primary.mcnemarP).toBeLessThan(0.05);
    expect(e.primary.difference).toBe(-1);
    expect(e.primary.purposeBeatsPopularity).toBe(false);
  });

  it('an empty scored set has no difference and no win, and is VOID', () => {
    const e = evaluateRetrieval([outcomes[4]]);
    expect(e.primary).toMatchObject({ n: 0, difference: null, mcnemarP: 1 });
    expect(e.primary.purposeBeatsPopularity).toBe(false);
    expect(e.verdict).toEqual({ verdict: 'VOID', reason: 'no prompt scored' });
    const report = renderRetrievalReport(e, { labeledIndexDocuments: 7000 });
    expect(report).toContain(
      'Difference (PURPOSE - POPULARITY): —. Decision rule (b > c AND p < 0.05): does not hold.'
    );
  });

  it('renders the sample, primary and strata lines exactly', () => {
    const report = renderRetrievalReport(evaluateRetrieval(outcomes), {
      labeledIndexDocuments: 7000,
    });
    for (const line of [
      '| drawn | 9 |',
      '| excluded: stage-1 failed | 1 |',
      '| excluded: role = none | 1 |',
      '| excluded: no in-role attachment | 1 |',
      '| excluded: an arm errored | 1 |',
      '| excluded: PURPOSE label read fell back | 1 |',
      '| **scored** | **4** |',
      "Attached models outside the judged role's types (excluded from the gold): 10 of 17 (58.8%), over rows whose stage 1 produced a non-none role. Of those, 6 are checkpoints; without them: 4 of 11 (36.4%).",
      '| all scored | 4 | 75.0% | 50.0% | 2 | 1 | 1.00 |',
      '| hit@50 | 4 | 75.0% | 75.0% | 1 | 1 | 1.00 |',
      '| gold labeled | 2 | 50.0% | 50.0% | 1 | 1 | 1.00 |',
      '| gold unlabeled | 2 | 100.0% | 50.0% | 1 | 0 | 1.00 |',
      'Difference (PURPOSE - POPULARITY): 25.0%. Decision rule (b > c AND p < 0.05): does not hold.',
      '## Verdict: VOID',
      'VOID — infrastructure exclusions 3 of 9 drawn exceed 10%.',
      'Positive control: 7000 index documents carry a non-none `insight.role` (floor 100).',
      // The pilot's two rates: 4 of 9 drawn scored; (2 + 1) / 4 discordant.
      'Power assumption — scored fraction: 44.4% of drawn (assumed >= 66.7%); discordant rate (b + c) / scored at hit@10: 75.0% (assumed >= 15.0%). 🔴 BELOW THE ASSUMPTION — re-plan the sample size in a new commit before the registered run.',
    ]) {
      expect(report).toContain(line);
    }
    expect(report).not.toMatch(/bootstrap|NOT DEMONSTRATED/);
  });
});

// ---------------------------------------------------------------------------
// The verdict — every outcome maps to exactly one
// ---------------------------------------------------------------------------

describe('retrievalVerdict — MET / NOT MET / VOID', () => {
  /**
   * A registered-size run: `p` PURPOSE-only hits, `q` POPULARITY-only, `both` and
   * `neither` shared, plus `infra` infrastructure exclusions spread over all three kinds.
   */
  const run = ({
    p = 0,
    q = 0,
    both = 0,
    neither = 0,
    infra = [0, 0, 0] as [number, number, number],
  }) => {
    let id = 0;
    const scored = (hitP: boolean, hitQ: boolean) =>
      scoredOutcome(++id, {
        purposeModelIds: rankedWith(hitP ? 100 : null, 1),
        // A POPULARITY list that differs from PURPOSE's even when both miss.
        popularityModelIds: hitQ ? rankedWith(100, 2) : rankedWith(null, 1).map((x) => x + 5000),
      });
    const excluded = (status: 'stage1_failed' | 'arm_error' | 'insight_fallback') =>
      ({
        imageId: ++id,
        status,
        role: status === 'stage1_failed' ? null : 'style',
        attachedCount: 1,
        checkpointCount: 0,
        inRoleCount: status === 'stage1_failed' ? 0 : 1,
      } as Outcome);
    return [
      ...Array.from({ length: p }, () => scored(true, false)),
      ...Array.from({ length: q }, () => scored(false, true)),
      ...Array.from({ length: both }, () => scored(true, true)),
      ...Array.from({ length: neither }, () => scored(false, false)),
      ...Array.from({ length: infra[0] }, () => excluded('stage1_failed')),
      ...Array.from({ length: infra[1] }, () => excluded('arm_error')),
      ...Array.from({ length: infra[2] }, () => excluded('insight_fallback')),
    ];
  };
  const verdictOf = (rows: Outcome[], params = PREREGISTERED_RUN_PARAMS) =>
    evaluateRetrieval(rows, params).verdict;

  // 700 scored: 100 vs 50 discordant (p ≈ 6e-5) — the rule holds.
  const winning = run({ p: 100, q: 50, both: 200, neither: 350 });

  it('MET iff the decision rule holds on a registered, scoring, non-degraded run', () => {
    expect(verdictOf(winning).verdict).toBe('MET');
  });

  it('NOT MET when the rule fails: a loss, a tie, a non-significant win', () => {
    expect(verdictOf(run({ p: 50, q: 100, both: 200, neither: 350 })).verdict).toBe('NOT MET');
    expect(verdictOf(run({ p: 60, q: 60, both: 200, neither: 380 })).verdict).toBe('NOT MET');
    const nonSignificant = verdictOf(run({ p: 60, q: 50, both: 200, neither: 390 }));
    expect(nonSignificant.verdict).toBe('NOT MET');
    expect(nonSignificant.reason).toBe(
      'the decision rule does not hold (b = 60, c = 50); the question is closed as not delivered'
    );
  });

  it('VOID — and never MET — on an overridden run, even one the rule would pass', () => {
    const e = evaluateRetrieval(winning, { ...PREREGISTERED_RUN_PARAMS, sampleSize: 100 });
    expect(e.primary.purposeBeatsPopularity).toBe(true);
    expect(e.verdict).toEqual({
      verdict: 'VOID',
      reason: 'not the registered run (overridden: sampleSize: 1000 -> 100)',
    });
  });

  it('VOID when no prompt scored', () => {
    expect(verdictOf([])).toEqual({ verdict: 'VOID', reason: 'no prompt scored' });
  });

  it('🔴 VOID below the minimum scored n — 667 is judged, 666 is not', () => {
    // A rule-passing split at both sizes: 100 vs 50 discordant.
    expect(verdictOf(run({ p: 100, q: 50, both: 200, neither: 317 })).verdict).toBe('MET');
    expect(verdictOf(run({ p: 100, q: 50, both: 200, neither: 316 }))).toEqual({
      verdict: 'VOID',
      reason: '666 prompts scored, under the 667 the power calculation assumes',
    });
    // The degraded-run shape that motivated it: ~50 scored, a non-significant split.
    expect(verdictOf(run({ p: 14, q: 11, neither: 25 })).verdict).toBe('VOID');
  });

  it('🔴 VOID when infrastructure exclusions exceed 10% of drawn — 100 of 1000 is judged, 101 is not', () => {
    // 900 scored + 100 infra = 1000 drawn: exactly 10%, judged.
    expect(
      verdictOf(run({ p: 100, q: 50, both: 200, neither: 550, infra: [34, 33, 33] })).verdict
    ).toBe('MET');
    // 899 scored + 101 infra: over 10%. Every kind counts toward it.
    expect(verdictOf(run({ p: 100, q: 50, both: 200, neither: 549, infra: [34, 34, 33] }))).toEqual(
      {
        verdict: 'VOID',
        reason: 'infrastructure exclusions 101 of 1000 drawn exceed 10%',
      }
    );
  });

  it('VOID when the arms are identical at K on every scored prompt', () => {
    const identical = Array.from({ length: 700 }, (_, i) =>
      scoredOutcome(i + 1, {
        purposeModelIds: rankedWith(null, 1),
        popularityModelIds: rankedWith(null, 1),
      })
    );
    expect(verdictOf(identical)).toEqual({
      verdict: 'VOID',
      reason: 'both arms returned the same first 10 model ids on every scored prompt',
    });
    // One prompt that differs is enough to leave VOID.
    expect(verdictOf([...identical, ...run({ p: 1 })]).verdict).toBe('NOT MET');
  });

  it('the report prints exactly one verdict', () => {
    for (const [rows, params, expected] of [
      [winning, PREREGISTERED_RUN_PARAMS, 'MET'],
      [run({ p: 60, q: 50, both: 200, neither: 390 }), PREREGISTERED_RUN_PARAMS, 'NOT MET'],
      [winning, { ...PREREGISTERED_RUN_PARAMS, sampleDays: 7 }, 'VOID'],
    ] as const) {
      const report = renderRetrievalReport(evaluateRetrieval(rows, params), {
        labeledIndexDocuments: 7000,
      });
      const verdicts = report.split('\n').filter((line) => line.startsWith('## Verdict: '));
      expect(verdicts).toEqual([`## Verdict: ${expected}`]);
    }
  });

  it('is a pure mapping over the evaluation fields', () => {
    const base = {
      overrides: [],
      drawn: 700,
      excluded: { stage1_failed: 0, arm_error: 0, insight_fallback: 0 },
      primary: { n: 700, b: 100, c: 50 },
      identicalAtPrimaryK: 0,
    };
    expect(retrievalVerdict(base).verdict).toBe('MET');
    expect(retrievalVerdict({ ...base, identicalAtPrimaryK: 700 }).verdict).toBe('VOID');
    expect(
      retrievalVerdict({ ...base, excluded: { ...base.excluded, insight_fallback: 71 } }).verdict
    ).toBe('VOID');
  });
});

// ---------------------------------------------------------------------------
// The runner, over a fake index
// ---------------------------------------------------------------------------

const BASE_MODEL = 'Pony';
const COVERAGE = { next: false, member: false };
const ARM_OPTS = { browsingLevel: 3, coverage: COVERAGE, cap: 50 };

type FakeVersion = { id: number; name: string; baseModel: string; canGenerate: boolean };
type FakeDoc = {
  id: number;
  name: string;
  type: string;
  metrics: { thumbsUpCount: number };
  versions: FakeVersion[];
  insight: { qualityScore: number | null; role: string | null; styleFamily: string | null };
};

const doc = (
  id: number,
  thumbsUpCount: number,
  label?: { role: string; qualityScore: number },
  versions?: FakeVersion[]
): FakeDoc => ({
  id,
  name: `model-${id}`,
  type: 'LORA',
  metrics: { thumbsUpCount },
  versions: versions ?? [{ id: id * 10, name: 'v1', baseModel: BASE_MODEL, canGenerate: true }],
  insight: label
    ? { qualityScore: label.qualityScore, role: label.role, styleFamily: 'anime_manga' }
    : { qualityScore: null, role: null, styleFamily: null },
});

const SORTABLE: Record<string, (d: FakeDoc) => number | null> = {
  'insight.qualityScore': (d) => d.insight.qualityScore,
  'metrics.thumbsUpCount': (d) => d.metrics.thumbsUpCount,
};

/** Honours an `insight.role = "<x>"` clause, the sort array (nulls last) and `limit`. */
function fakeIndex(corpus: FakeDoc[]) {
  return (params: SearchParams) => {
    const filter = typeof params.filter === 'string' ? params.filter : '';
    const role = /insight\.role = "([^"]+)"/.exec(filter)?.[1];
    const keys = (params.sort ?? []).map((key) => {
      const [field, dir] = key.split(':');
      const read = SORTABLE[field];
      if (!read) throw new Error(`fake index: unsupported sort field ${field}`);
      return { read, desc: dir === 'desc' };
    });
    const hits = corpus
      .filter((d) => role === undefined || d.insight.role === role)
      .slice()
      .sort((x, y) => {
        for (const { read, desc } of keys) {
          const vx = read(x);
          const vy = read(y);
          if (vx === vy) continue;
          if (vx === null) return 1;
          if (vy === null) return -1;
          return desc ? vy - vx : vx - vy;
        }
        return 0;
      })
      .slice(0, params.limit ?? 20);
    return { hits, estimatedTotalHits: hits.length };
  };
}

// Model 4 is the ONLY model labeled for `style`, and the least popular: the purpose arm's
// re-rank must move it first, and a popularity arm that did no label ordering must keep it
// last.
const CORPUS = [
  doc(1, 900),
  doc(2, 800, { role: 'clothing', qualityScore: 0.9 }),
  doc(3, 700),
  doc(4, 10, { role: 'style', qualityScore: 0.8 }),
];

const labelRows = [
  {
    modelVersionId: 20,
    role: 'clothing',
    styleFamily: 'photorealistic',
    qualityScore: 0.9,
    confidence: 0.95,
  },
  {
    modelVersionId: 40,
    role: 'style',
    styleFamily: 'anime_manga',
    qualityScore: 0.8,
    confidence: 0.95,
  },
];

const serveCorpus = (corpus: FakeDoc[]) => {
  const search = fakeIndex(corpus);
  searchWithSignal.mockImplementation(async (_index: unknown, _q: string, params: SearchParams) =>
    search(params)
  );
};

const intentFor = (role: ResourceIntentRole): ResourceIntentAnswer => ({
  needsResource: 0.9,
  role: { value: role, distribution: { [role]: 1 } },
  styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
  contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
  specificity: 3,
  injectionPresent: 0,
});

// The endpoint's own compiler, not a test copy of it.
const stage1As = (role: ResourceIntentRole) =>
  vi.fn(async (_prompt: string, baseModel: string | null) => ({
    intent: intentFor(role),
    criteria: compileCriteria(intentFor(role), baseModel),
  }));

const row = (imageId: number, over: Partial<GoldRow> = {}): GoldRow => ({
  imageId,
  prompt: `prompt ${imageId}`,
  attachedModels: [
    { modelId: 900, modelType: 'Checkpoint' },
    { modelId: 4, modelType: 'LORA' },
  ],
  checkpointBaseModels: [BASE_MODEL],
  ...over,
});

const searchCalls = () => searchWithSignal.mock.calls.map((call) => call[2] as SearchParams);

beforeEach(() => {
  meiliHolder.client = { index: () => ({}) };
  searchWithSignal.mockReset();
  serveCorpus(CORPUS);
  dbMock.dbRead.resourceInsight.findMany.mockReset();
  dbMock.dbRead.resourceInsight.findMany.mockImplementation((async (args: {
    where: { modelVersionId: { in: number[] } };
  }) => labelRows.filter((r) => args.where.modelVersionId.in.includes(r.modelVersionId))) as never);
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('the fake index — controls on the instrument', () => {
  const search = fakeIndex(CORPUS);
  it('honours the role clause, the sort and the limit; refuses an unknown sort', () => {
    expect(search({ filter: 'x AND insight.role = "style"' }).hits.map((d) => d.id)).toEqual([4]);
    expect(
      search({ sort: ['metrics.thumbsUpCount:desc'], limit: 10 }).hits.map((d) => d.id)
    ).toEqual([1, 2, 3, 4]);
    expect(search({ sort: ['insight.qualityScore:desc'], limit: 2 }).hits.map((d) => d.id)).toEqual(
      [2, 4]
    );
    expect(() => search({ sort: ['metrics.downloadCount:desc'] })).toThrow(/unsupported/);
  });
});

describe('runRetrievalArms — the two arms', () => {
  it('🔴 the PURPOSE arm re-ranks the labeled match first; the POPULARITY arm keeps pure thumbs-up order', async () => {
    const [outcome] = await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set([4]),
    });
    expect(outcome).toMatchObject({
      status: 'scored',
      role: 'style',
      goldModelIds: [4],
      goldLabeled: true,
      // 4 promoted (role and style agree); 2 demoted (a confident label for another
      // purpose and another style).
      purposeModelIds: [4, 1, 3, 2],
      popularityModelIds: [1, 2, 3, 4],
    });
    // Both arms put model 4 inside the first 10, so hit@10 does not separate them here.
    expect(evaluateRetrieval([outcome]).primary).toMatchObject({ b: 0, c: 0 });
  });

  it('🔴 the POPULARITY arm never reads labels and never asks for a quality sort or a role filter', async () => {
    await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: {
        purpose: async () => ({ entries: [], insightFallback: false }),
        popularity: popularityArm,
      },
    });
    expect(dbMock.dbRead.resourceInsight.findMany).not.toHaveBeenCalled();
    const calls = searchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].sort).toEqual(['metrics.thumbsUpCount:desc']);
    expect(String(calls[0].filter)).not.toContain('insight.');
  });

  it('🔴 both arms search under the SAME gate filter, derived from the same criteria', async () => {
    await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
    });
    const gate = buildResourceIntentFilter({
      modelTypes: ROLE_MODEL_TYPES.style,
      baseModels: [BASE_MODEL],
      browsingLevel: ARM_OPTS.browsingLevel,
      coverage: COVERAGE,
    });
    // One seed page per arm, identical.
    expect(searchCalls().map((c) => c.filter)).toEqual([gate, gate]);
    expect(searchCalls().map((c) => c.sort)).toEqual([
      ['metrics.thumbsUpCount:desc'],
      ['metrics.thumbsUpCount:desc'],
    ]);
    expect(searchCalls().map((c) => c.limit)).toEqual([100, 100]);
  });

  it('caps both arms at the same response width, out of the same pool width', async () => {
    // cap 2 → pool 4: the whole 4-document corpus enters each pool; each arm returns 2.
    const [outcome] = await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: { ...ARM_OPTS, cap: 2 },
      labeledModelIds: new Set(),
    });
    expect(outcome).toMatchObject({ purposeModelIds: [4, 1], popularityModelIds: [1, 2] });
    expect(searchCalls().map((c) => c.limit)).toEqual([4, 4]);
  });

  it('the POPULARITY arm expands versions like the matcher: requested baseModel only, one model once', async () => {
    serveCorpus([
      doc(7, 999, undefined, [
        { id: 71, name: 'sdxl', baseModel: 'SDXL 1.0', canGenerate: true },
        { id: 72, name: 'pony-a', baseModel: BASE_MODEL, canGenerate: true },
        { id: 73, name: 'pony-b', baseModel: BASE_MODEL, canGenerate: true },
      ]),
      doc(8, 5),
    ]);
    const criteria = compileCriteria(intentFor('style'), BASE_MODEL);
    const { entries } = await popularityArm(criteria, ARM_OPTS);
    expect(entries.map((e) => e.versionId)).toEqual([72, 73, 80]);
    expect(rankedModelIds(entries)).toEqual([7, 8]);
  });

  it('hands both arms the identical criteria and options objects', async () => {
    const purpose = vi.fn(async () => ({ entries: [], insightFallback: false }));
    const popularity = vi.fn(async () => ({ entries: [], insightFallback: false }));
    await runRetrievalArms([row(1)], {
      stage1: stage1As('clothing'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: { purpose, popularity },
    });
    expect(purpose).toHaveBeenCalledTimes(1);
    expect(popularity).toHaveBeenCalledTimes(1);
    const [pCriteria, pOpts] = purpose.mock.calls[0] as unknown as [ResourceIntentCriteria, object];
    const [qCriteria, qOpts] = popularity.mock.calls[0] as unknown as [
      ResourceIntentCriteria,
      object
    ];
    expect(qCriteria).toBe(pCriteria);
    expect(qOpts).toBe(pOpts);
    expect(pCriteria).toMatchObject({ role: 'clothing', baseModel: BASE_MODEL });
    expect(pOpts).toEqual(ARM_OPTS);
  });

  it('labels a prompt by its IN-ROLE gold only, and by ANY labeled in-role model', async () => {
    const outcomes = await runRetrievalArms(
      [
        // The only labeled model is the out-of-role checkpoint → unlabeled.
        row(1),
        // Two in-role models, one labeled → labeled.
        row(2, {
          attachedModels: [
            { modelId: 4, modelType: 'LORA' },
            { modelId: 5, modelType: 'LORA' },
          ],
        }),
      ],
      {
        stage1: stage1As('style'),
        armOpts: ARM_OPTS,
        labeledModelIds: new Set([900, 5]),
        arms: {
          purpose: async () => ({ entries: [], insightFallback: false }),
          popularity: async () => ({ entries: [], insightFallback: false }),
        },
      }
    );
    expect(outcomes.map((o) => (o.status === 'scored' ? o.goldLabeled : o.status))).toEqual([
      false,
      true,
    ]);
  });
});

describe('runRetrievalArms — exclusions', () => {
  it('🔴 skips role = none without running either arm', async () => {
    const purpose = vi.fn();
    const popularity = vi.fn();
    const outcomes = await runRetrievalArms([row(1)], {
      stage1: stage1As('none'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: { purpose, popularity },
    });
    expect(outcomes).toEqual([
      {
        imageId: 1,
        status: 'role_none',
        role: 'none',
        attachedCount: 2,
        checkpointCount: 1,
        inRoleCount: 0,
      },
    ]);
    expect(purpose).not.toHaveBeenCalled();
    expect(popularity).not.toHaveBeenCalled();
    expect(evaluateRetrieval(outcomes).excluded.role_none).toBe(1);
  });

  it('🔴 excludes out-of-role attachments from the gold, and counts them', async () => {
    const outcomes = await runRetrievalArms(
      [
        row(1), // Checkpoint 900 (out of role) + LORA 4 (in role)
        row(2, { attachedModels: [{ modelId: 900, modelType: 'Checkpoint' }] }),
      ],
      { stage1: stage1As('style'), armOpts: ARM_OPTS, labeledModelIds: new Set() }
    );
    expect(outcomes[0]).toMatchObject({
      status: 'scored',
      goldModelIds: [4],
      attachedCount: 2,
      checkpointCount: 1,
      inRoleCount: 1,
    });
    expect(outcomes[1]).toEqual({
      imageId: 2,
      status: 'no_in_role_attachment',
      role: 'style',
      attachedCount: 1,
      checkpointCount: 1,
      inRoleCount: 0,
    });
    const e = evaluateRetrieval(outcomes);
    expect(e.outOfRole).toEqual({ attached: 3, excluded: 2, checkpoints: 2 });
    expect(e.excluded.no_in_role_attachment).toBe(1);
    expect(e.primary.n).toBe(1);
  });

  it('excludes and counts a failed stage 1, an erroring arm and a label-read fallback', async () => {
    const stage1 = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('vendor down'))
      .mockImplementation(async (_p: string, baseModel: string | null) => ({
        intent: intentFor('style'),
        criteria: compileCriteria(intentFor('style'), baseModel),
      }));
    const purpose = vi
      .fn()
      .mockRejectedValueOnce(new Error('index down'))
      .mockResolvedValueOnce({ entries: [], insightFallback: true });
    const popularity = vi.fn(async () => ({ entries: [], insightFallback: false }));
    const outcomes = await runRetrievalArms([row(1), row(2), row(3), row(4)], {
      stage1,
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: { purpose, popularity },
    });
    expect(outcomes.map((o) => o.status)).toEqual([
      'stage1_failed',
      'stage1_failed',
      'arm_error',
      'insight_fallback',
    ]);
    expect(outcomes[1]).toMatchObject({ detail: 'vendor down' });
    expect(outcomes[2]).toMatchObject({ detail: 'index down' });
  });

  it('a REAL purpose arm whose label read fails is excluded as insight_fallback', async () => {
    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('relation missing'));
    const outcomes = await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
    });
    expect(outcomes.map((o) => o.status)).toEqual(['insight_fallback']);
  });

  it('asks stage 1 with the single attached checkpoint base model, else none', async () => {
    const stage1 = stage1As('style');
    await runRetrievalArms(
      [
        row(1),
        row(2, { checkpointBaseModels: ['Pony', 'SDXL 1.0'] }),
        row(3, { checkpointBaseModels: [] }),
      ],
      {
        stage1,
        armOpts: ARM_OPTS,
        labeledModelIds: new Set(),
        arms: {
          purpose: async () => ({ entries: [], insightFallback: false }),
          popularity: async () => ({ entries: [], insightFallback: false }),
        },
      }
    );
    expect(stage1.mock.calls.map((call) => call[1])).toEqual(['Pony', null, null]);
    expect(requestBaseModel(row(9))).toBe('Pony');
  });

  it('inRoleGold dedupes by model and admits only the role types', () => {
    const gold = inRoleGold(
      row(1, {
        attachedModels: [
          { modelId: 4, modelType: 'LORA' },
          { modelId: 4, modelType: 'LORA' },
          { modelId: 5, modelType: 'Controlnet' },
          { modelId: 6, modelType: 'TextualInversion' },
        ],
      }),
      'style'
    );
    expect(gold.map((m) => m.modelId)).toEqual([4, 6]);
    expect(inRoleGold(row(1), 'none')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Labels and the positive control
// ---------------------------------------------------------------------------

describe('loadLabeledModelIds — the index projection rule, over every version', () => {
  it('labels a model iff the projection would write it', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      { id: 20, modelId: 2 },
      { id: 21, modelId: 2 },
      { id: 30, modelId: 3 },
      { id: 40, modelId: 4 },
    ] as never);
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      // model 2: one confident row on its second version → labeled
      {
        modelVersionId: 21,
        role: 'style',
        styleFamily: 'other',
        qualityScore: 0.5,
        confidence: 0.95,
      },
      // model 3: below every floor → not labeled
      {
        modelVersionId: 30,
        role: 'style',
        styleFamily: 'other',
        qualityScore: 0.5,
        confidence: 0.01,
      },
    ] as never);
    expect(await loadLabeledModelIds([2, 3, 4])).toEqual(new Set([2]));
    expect(dbMock.dbRead.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { modelId: { in: [2, 3, 4] } } })
    );
  });

  it('reads nothing for no models', async () => {
    dbMock.dbRead.modelVersion.findMany.mockReset();
    expect(await loadLabeledModelIds([])).toEqual(new Set());
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
  });
});

describe('countLabeledIndexDocuments — the positive control', () => {
  it('counts exactly the non-none roles, in one zero-width query', async () => {
    const search = vi.fn(async () => ({ hits: [], estimatedTotalHits: 1234 }));
    meiliHolder.client = { index: () => ({ search }) };
    expect(await countLabeledIndexDocuments()).toBe(1234);
    expect(search).toHaveBeenCalledWith('', {
      filter:
        'insight.role IN ["style", "character", "subject_detail", "pose_composition", "environment_scene", "clothing", "quality_enhancer", "control_guidance"]',
      limit: 0,
    });
  });

  it('reads 0 with no search client or no count', async () => {
    meiliHolder.client = null;
    expect(await countLabeledIndexDocuments()).toBe(0);
    meiliHolder.client = { index: () => ({ search: async () => ({ hits: [] }) }) };
    expect(await countLabeledIndexDocuments()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The CLI gate (main in ../eval-resource-intent-goldset)
// ---------------------------------------------------------------------------

const STAGE1_ANSWERS = (role: string) => [
  { id: 'needsResource', type: 'noul' as const, value: 0.9 },
  { id: 'role', type: 'choice' as const, value: role, distribution: { [role]: 1 } },
  {
    id: 'styleFamily',
    type: 'choice' as const,
    value: 'anime_manga',
    distribution: { anime_manga: 1 },
  },
  {
    id: 'contentType',
    type: 'choice' as const,
    value: 'portrait_character',
    distribution: { portrait_character: 1 },
  },
  { id: 'specificity', type: 'score' as const, value: 3 },
  { id: 'injectionPresent', type: 'noul' as const, value: 0 },
];

describe('main — the --execute gate', () => {
  const runMain = async (args: string[]) => {
    const argv = process.argv;
    process.argv = ['node', 'goldset-under-test', ...args];
    // Spies are restored in `finally`, so a failing assertion cannot leak them, and the
    // CALLS are copied out first so the assertions still see them.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await goldsetModule.main().then(
        () => 'ok' as const,
        (error: Error) => error
      );
      return {
        result,
        log: { mock: { calls: [...log.mock.calls] } },
        warn: { mock: { calls: [...warn.mock.calls] } },
      };
    } finally {
      process.argv = argv;
      log.mockRestore();
      warn.mockRestore();
    }
  };

  const controlReturns = (estimatedTotalHits: number) => {
    const search = vi.fn(async () => ({ hits: [], estimatedTotalHits }));
    meiliHolder.client = { index: () => ({ search }) };
    return search;
  };

  beforeEach(() => {
    flagTable.mockReset();
    flagTable.mockReturnValue(false);
    fliptSync.mockReset();
    fliptSync.mockImplementation((flag, entityId) => flagTable(flag, entityId));
    fliptClientHolder.current = fliptClient;
    vi.unstubAllEnvs();
    fliptClient.close.mockReset();
    dbMock.dbRead.$disconnect.mockReset();
    dbMock.dbRead.$disconnect.mockResolvedValue(undefined as never);
    askJev.mockReset();
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbRead.modelVersion.findMany.mockReset();
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([] as never);
  });

  it('without --execute prints the queries and the pre-registration, and spends nothing', async () => {
    const { result, log, warn } = await runMain([]);
    expect(result).toBe('ok');
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('Dry run.');
    expect(printed).toContain('WITH sampled AS');
    expect(printed).toContain(renderRetrievalPreregistration());
    expect(warn.mock.calls).toEqual([]);
    expect(askJev).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(searchWithSignal).not.toHaveBeenCalled();
  });

  it('warns loudly when a flag overrides the pre-registration', async () => {
    const { warn } = await runMain(['--retrieval-sample', '100', '--days', '7']);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('OVERRIDE the pre-registration');
    expect(warned).toContain('its verdict is VOID');
    for (const fragment of ['sampleSize: 1000 -> 100', 'sampleDays: 30 -> 7']) {
      expect(warned).toContain(fragment);
    }
  });

  it.each(['--k', '--bootstrap-seed'])('no longer accepts %s', async (flag) => {
    const { result } = await runMain([flag, '5']);
    expect(String(result)).toContain(`Unknown option '${flag}'`);
  });

  it('refuses a malformed override instead of silently using the default', async () => {
    const { result } = await runMain(['--retrieval-sample', 'ten']);
    expect(String(result)).toContain('--retrieval-sample must be a positive integer');
  });

  it.each([
    [99, 'aborts'],
    [100, 'proceeds with'],
  ] as const)(
    '🔴 with --execute, a positive-control count of %i %s the run (abort = before any query or vendor call)',
    async (count, verdict) => {
      controlReturns(count);
      const { result } = await runMain(['--execute', '--limit', '2']);
      if (verdict === 'proceeds with') {
        expect(result).toBe('ok');
        expect(dbMock.dbRead.$queryRaw).toHaveBeenCalled();
      } else {
        expect(String(result)).toContain(
          `positive control FAILED: ${count} models-index documents`
        );
        expect(askJev).not.toHaveBeenCalled();
        expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
      }
    }
  );

  it('🔴 the shared matched draw: part one takes a prefix plus the unmatched rows, part two the first sampleSize', async () => {
    controlReturns(7000);
    const matchedRows = [11, 12, 13].map((imageId) => ({
      imageId,
      prompt: `matched prompt ${imageId}`,
      attachedTypes: ['Checkpoint', 'LORA'],
      attachedBaseModels: [BASE_MODEL],
      attachedModels: [
        { modelId: 900, modelType: 'Checkpoint' },
        { modelId: 4, modelType: 'LORA' },
      ],
      checkpointBaseModels: [BASE_MODEL],
    }));
    const unmatchedRow = {
      imageId: 21,
      prompt: 'unmatched prompt',
      attachedTypes: [],
      attachedBaseModels: [],
    };
    dbMock.dbRead.$queryRaw.mockImplementation((async (query: { sql: string }) =>
      query.sql.includes('WITH sampled AS') ? matchedRows : [unmatchedRow]) as never);
    askJev.mockImplementation(async () => ({
      answers: STAGE1_ANSWERS('style'),
      model: 'typesafe/jev-1.13-20260917',
      usage: { promptTokens: 1, completionTokens: 1 },
    }));

    // --limit 2 → part one: 1 matched + 1 unmatched; --retrieval-sample 2 → draw 2.
    const { result, log } = await runMain(['--execute', '--limit', '2', '--retrieval-sample', '2']);
    expect(result).toBe('ok');
    const matchedQuery = dbMock.dbRead.$queryRaw.mock.calls[0][0] as unknown as {
      values: unknown[];
    };
    expect(matchedQuery.values).toEqual([30, 2]);
    expect(askJev.mock.calls.map((call) => call[0])).toEqual([
      // part one: the first matched row, then the unmatched row, no baseModel
      buildResourceIntentStage1Request('matched prompt 11', null),
      buildResourceIntentStage1Request('unmatched prompt', null),
      // part two: the first TWO matched rows (the mock returned three), checkpoint baseModel
      buildResourceIntentStage1Request('matched prompt 11', BASE_MODEL),
      buildResourceIntentStage1Request('matched prompt 12', BASE_MODEL),
    ]);
    const report = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(report).toContain('Judged 2 of 2 drawn rows; 0 skipped on a stage-1 failure.');
    expect(report).toContain('| **scored** | **2** |');
  });

  it('🔴 with --execute and Flipt unreachable, aborts before the index, the replica or the vendor', async () => {
    const search = controlReturns(7000);
    fliptSync.mockReturnValue(null);
    const { result } = await runMain(['--execute', '--limit', '2']);
    expect(String(result)).toContain('feature flags could not be evaluated');
    expect(search).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(askJev).not.toHaveBeenCalled();
  });

  it('🔴 with --execute and a coverage flag overridden locally (the default env reader), aborts before the index', async () => {
    const search = controlReturns(7000);
    vi.stubEnv('FLIPT_LOCAL_OVERRIDES', 'generation-loading-open-to-all=on');
    const { result } = await runMain(['--execute', '--limit', '2']);
    expect(String(result)).toContain('FLIPT_LOCAL_OVERRIDES sets generation-loading-open-to-all');
    expect(search).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('🔴 with --execute and no initialised Flipt client (the default reader), aborts before the index', async () => {
    const search = controlReturns(7000);
    fliptClientHolder.current = null;
    const { result } = await runMain(['--execute', '--limit', '2']);
    expect(String(result)).toContain('the Flipt client did not initialise');
    expect(search).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('🔴 the arms receive the RESOLVED coverage — next on, open-to-all off → {next:true, member:false}, not the defaults', async () => {
    controlReturns(7000);
    // The live state the first pilot missed: coverage-next ON, open-to-all OFF.
    flagTable.mockImplementation((flag) => flag === 'generation-coverage-next');
    dbMock.dbRead.$queryRaw.mockImplementation((async (query: { sql: string }) =>
      query.sql.includes('WITH sampled AS')
        ? [
            {
              imageId: 11,
              prompt: 'a knight in anime style',
              attachedTypes: ['LORA'],
              attachedBaseModels: [BASE_MODEL],
              attachedModels: [{ modelId: 4, modelType: 'LORA' }],
              checkpointBaseModels: [BASE_MODEL],
            },
          ]
        : []) as never);
    askJev.mockImplementation(async () => ({
      answers: STAGE1_ANSWERS('style'),
      model: 'typesafe/jev-1.13-20260917',
      usage: { promptTokens: 1, completionTokens: 1 },
    }));

    const { result, log } = await runMain(['--execute', '--limit', '2']);
    expect(result).toBe('ok');

    // The guard asked isFliptSync for each flag with coverageAudience's entity ids.
    expect(fliptSync.mock.calls).toEqual([
      ['generation-coverage-next', 'global'],
      ['generation-loading-open-to-all', '0'],
    ]);
    // Printed …
    const report = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(report).toContain(
      'Coverage (resolved as the endpoint does, for an anonymous caller): next=true, member=false.'
    );
    // … and what BOTH arms actually filtered on.
    const resolvedGate = buildResourceIntentFilter({
      modelTypes: ROLE_MODEL_TYPES.style,
      baseModels: [BASE_MODEL],
      browsingLevel: allBrowsingLevelsFlag,
      coverage: { next: true, member: false },
    });
    const defaultGate = buildResourceIntentFilter({
      modelTypes: ROLE_MODEL_TYPES.style,
      baseModels: [BASE_MODEL],
      browsingLevel: allBrowsingLevelsFlag,
      coverage: { next: false, member: true },
    });
    // Control: the two coverages really produce different filters, so this can tell them apart.
    expect(resolvedGate).not.toBe(defaultGate);
    expect(searchCalls().map((c) => c.filter)).toEqual([resolvedGate, resolvedGate]);
  });

  it('🔴 end to end: one matched draw, the endpoint stage 1, both arms, the report', async () => {
    controlReturns(7000);
    const matchedRow = {
      imageId: 11,
      prompt: 'a knight in anime style',
      attachedTypes: ['Checkpoint', 'LORA'],
      attachedBaseModels: [BASE_MODEL],
      attachedModels: [
        { modelId: 900, modelType: 'Checkpoint' },
        { modelId: 4, modelType: 'LORA' },
      ],
      checkpointBaseModels: [BASE_MODEL],
    };
    dbMock.dbRead.$queryRaw.mockImplementation((async (query: { sql: string }) =>
      query.sql.includes('WITH sampled AS') ? [matchedRow] : []) as never);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      { id: 40, modelId: 4 },
      { id: 9000, modelId: 900 },
    ] as never);
    askJev.mockImplementation(async () => ({
      answers: STAGE1_ANSWERS('style'),
      model: 'typesafe/jev-1.13-20260917',
      usage: { promptTokens: 1, completionTokens: 1 },
    }));

    // Twelve unlabeled models more popular than model 4, so POPULARITY's first 10 miss it
    // while PURPOSE's re-rank promotes it to the head.
    serveCorpus([
      ...Array.from({ length: 12 }, (_, i) => doc(100 + i, 5000 - i)),
      doc(4, 10, { role: 'style', qualityScore: 0.8 }),
    ]);

    const { result, log } = await runMain(['--execute', '--limit', '2']);
    expect(result).toBe('ok');

    // ONE matched query (part one's prefix and part two share it) + one unmatched. The
    // matched draw is sized for the LARGER consumer: window 30 days, 1000 rows.
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(2);
    const [matchedQuery, unmatchedQuery] = dbMock.dbRead.$queryRaw.mock.calls.map(
      (call) => call[0] as unknown as { sql: string; values: unknown[] }
    );
    expect(matchedQuery.sql).toContain('WITH sampled AS');
    expect(matchedQuery.values).toEqual([30, 1000]);
    expect(unmatchedQuery.values).toEqual([30, 1]);
    // Stage 1: part one with no baseModel, part two with the checkpoint's — each
    // exactly the endpoint's own request.
    expect(askJev.mock.calls.map((call) => call[0])).toEqual([
      buildResourceIntentStage1Request(matchedRow.prompt, null),
      buildResourceIntentStage1Request(matchedRow.prompt, BASE_MODEL),
    ]);
    // Both arms: all browsing levels, the checkpoint's baseModel, pool 100 (cap 50).
    const gate = buildResourceIntentFilter({
      modelTypes: ROLE_MODEL_TYPES.style,
      baseModels: [BASE_MODEL],
      browsingLevel: allBrowsingLevelsFlag,
      coverage: COVERAGE,
    });
    expect(gate).toContain(
      `nsfwLevel IN [${Flags.instanceToArray(allBrowsingLevelsFlag).join(', ')}]`
    );
    expect(searchCalls().map((c) => c.filter)).toEqual([gate, gate]);
    expect(searchCalls().map((c) => c.limit)).toEqual([100, 100]);

    const report = log.mock.calls.map((call) => String(call[0])).join('\n');
    // Part one: the first ceil(2/2) = 1 matched row + no unmatched rows.
    expect(report).toContain('Judged 1 of 1 drawn rows; 0 skipped on a stage-1 failure.');
    // A registered run, scored at hit@10; the labeled model reaches the strata.
    expect(report).toContain('## Primary: hit@10');
    // Flags evaluated (real false): the coverage the endpoint resolves, printed.
    expect(report).toContain(
      'Coverage (resolved as the endpoint does, for an anonymous caller): next=false, member=true.'
    );
    expect(report).toContain('| all scored | 1 | 100.0% | 0.0% | 1 | 0 | 1.00 |');
    expect(report).toContain('| gold labeled | 1 | 100.0% | 0.0% | 1 | 0 | 1.00 |');
    // One scored prompt is far under the registered minimum: VOID, and exactly one verdict.
    expect(report.split('\n').filter((l) => l.startsWith('## Verdict: '))).toEqual([
      '## Verdict: VOID',
    ]);
    expect(report).not.toContain('NOT THE PRE-REGISTERED RUN');
    // The completion path closes what it opened, so the process can exit.
    expect(fliptClient.close).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('splits an ODD --limit as ceil to matched, floor to unmatched', async () => {
    controlReturns(7000);
    const matchedRows = [11, 12, 13].map((imageId) => ({
      imageId,
      prompt: `matched prompt ${imageId}`,
      attachedTypes: ['LORA'],
      attachedBaseModels: [BASE_MODEL],
      attachedModels: [{ modelId: 4, modelType: 'LORA' }],
      checkpointBaseModels: [],
    }));
    // The mock ignores LIMIT, so it returns what the query asked for: 1 unmatched row.
    const unmatchedRows = [21].map((imageId) => ({
      imageId,
      prompt: `unmatched prompt ${imageId}`,
      attachedTypes: [],
      attachedBaseModels: [],
    }));
    dbMock.dbRead.$queryRaw.mockImplementation((async (query: { sql: string }) =>
      query.sql.includes('WITH sampled AS') ? matchedRows : unmatchedRows) as never);
    askJev.mockImplementation(async () => ({
      answers: STAGE1_ANSWERS('none'),
      model: 'typesafe/jev-1.13-20260917',
      usage: { promptTokens: 1, completionTokens: 1 },
    }));

    // --limit 3 → part one: ceil = 2 matched + floor = 1 unmatched.
    const { result, log } = await runMain(['--execute', '--limit', '3', '--retrieval-sample', '1']);
    expect(result).toBe('ok');
    const [matchedQuery, unmatchedQuery] = dbMock.dbRead.$queryRaw.mock.calls.map(
      (call) => call[0] as unknown as { values: unknown[] }
    );
    expect(matchedQuery.values).toEqual([30, 2]); // max(ceil(3/2), 1)
    expect(unmatchedQuery.values).toEqual([30, 1]); // floor(3/2)
    expect(askJev.mock.calls.slice(0, 3).map((call) => call[0])).toEqual([
      buildResourceIntentStage1Request('matched prompt 11', null),
      buildResourceIntentStage1Request('matched prompt 12', null),
      buildResourceIntentStage1Request('unmatched prompt 21', null),
    ]);
    const report = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(report).toContain('Judged 3 of 3 drawn rows; 0 skipped on a stage-1 failure.');
  });
});

// ---------------------------------------------------------------------------
// The coverage guard — never grade a filter the endpoint does not use
// ---------------------------------------------------------------------------

describe('resolveEndpointCoverage — fails closed when the coverage flags cannot be evaluated', () => {
  const deps = (evaluateSync: (flag: string, entityId: string) => boolean | null) => {
    const calls: string[] = [];
    const audience = vi.fn(async () => ({ next: true, member: false }));
    return {
      calls,
      audience,
      deps: {
        ensureInitialized: async () => {
          calls.push('init');
        },
        evaluateSync: (flag: string, entityId: string) => {
          calls.push(`${flag}@${entityId}`);
          return evaluateSync(flag, entityId);
        },
        audience,
      },
    };
  };

  it('🔴 Flipt unreachable (every flag null): throws, names both flags, never resolves an audience', async () => {
    const { deps: d, audience } = deps(() => null);
    await expect(executeModule.resolveEndpointCoverage(d)).rejects.toThrow(
      'feature flags could not be evaluated (generation-coverage-next, generation-loading-open-to-all)'
    );
    expect(audience).not.toHaveBeenCalled();
  });

  it('one flag unevaluable is enough to abort', async () => {
    const { deps: d, audience } = deps((flag) =>
      flag === 'generation-loading-open-to-all' ? null : true
    );
    await expect(executeModule.resolveEndpointCoverage(d)).rejects.toThrow(
      'feature flags could not be evaluated (generation-loading-open-to-all)'
    );
    expect(audience).not.toHaveBeenCalled();
  });

  it('🔴 refuses when FLIPT_LOCAL_OVERRIDES names a coverage flag — before evaluating anything', async () => {
    const { deps: d, audience, calls } = deps(() => true);
    await expect(
      executeModule.resolveEndpointCoverage({
        ...d,
        overriddenFlags: () => ['some-other-flag', 'generation-coverage-next'],
      })
    ).rejects.toThrow('FLIPT_LOCAL_OVERRIDES sets generation-coverage-next');
    expect(audience).not.toHaveBeenCalled();
    expect(calls).toEqual(['init']);
  });

  it('an override of an UNRELATED flag does not block the run', async () => {
    const { deps: d } = deps(() => false);
    await expect(
      executeModule.resolveEndpointCoverage({ ...d, overriddenFlags: () => ['some-other-flag'] })
    ).resolves.toEqual({ next: true, member: false });
  });

  it('🔴 refuses when the Flipt client did not initialise, even if every flag answers', async () => {
    const { deps: d, audience } = deps(() => true);
    await expect(
      executeModule.resolveEndpointCoverage({ ...d, clientInitialised: () => false })
    ).rejects.toThrow('the Flipt client did not initialise (Flipt unreachable)');
    expect(audience).not.toHaveBeenCalled();
  });

  it('a real FALSE is not a failure: both flags evaluated → the endpoint audience', async () => {
    const { deps: d, audience, calls } = deps(() => false);
    await expect(executeModule.resolveEndpointCoverage(d)).resolves.toEqual({
      next: true,
      member: false,
    });
    expect(audience).toHaveBeenCalledTimes(1);
    // Initialised first, then each flag with the entity id coverageAudience uses.
    expect(calls).toEqual([
      'init',
      'generation-coverage-next@global',
      'generation-loading-open-to-all@0',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shutdown — a finished --execute must exit, not hang on an open handle
// ---------------------------------------------------------------------------

describe('closeStudyHandles / runAsScript — a finished run exits', () => {
  it('closes the Flipt client and disconnects the replica', async () => {
    const order: string[] = [];
    await executeModule.closeStudyHandles({
      closeFlipt: () => order.push('flipt'),
      disconnectDb: async () => {
        order.push('db');
      },
    });
    expect(order).toEqual(['flipt', 'db']);
  });

  it('still disconnects the replica when closing Flipt throws', async () => {
    const disconnectDb = vi.fn(async () => undefined);
    await expect(
      executeModule.closeStudyHandles({
        closeFlipt: () => {
          throw new Error('close failed');
        },
        disconnectDb,
      })
    ).rejects.toThrow('close failed');
    expect(disconnectDb).toHaveBeenCalledTimes(1);
  });

  it('🔴 runAsScript exits 0 once main resolves, and 1 (only) when it throws', async () => {
    const exit = vi.fn();
    await goldsetModule.runAsScript(async () => undefined, exit);
    expect(exit.mock.calls).toEqual([[0]]);

    exit.mockClear();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await goldsetModule.runAsScript(async () => {
        throw new Error('boom');
      }, exit);
    } finally {
      error.mockRestore();
    }
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
