import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import { dailyArticleTiers } from '~/server/schema/article.schema';
import { CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import { placementSurfaceLabel, placementSurfaces } from '~/shared/utils/placement';
import type { CreatorScoreTier } from '~/shared/utils/creator-score-unlocks';
import {
  buildCreatorScoreLadder,
  creatorScoreGateState,
  currentCreatorScoreTier,
  describeCreatorScoreUnlocks,
  groupCreatorScoreUnlocks,
  nextCreatorScoreRung,
  pendingCreatorScoreUnlocks,
} from '~/shared/utils/creator-score-unlocks';

const unlocks = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs);

// The tiers as the CJ 3 migration seeds them, read from the SQL so a reseeded ladder is tested as shipped.
const seededTiers: CreatorScoreTier[] = [
  ...readFileSync(
    new URL(
      '../../../../packages/civitai-db-schema/prisma/migrations/20261005120000_creator_milestone/migration.sql',
      import.meta.url
    ),
    'utf8'
  ).matchAll(/\('(score:\w+)',\s*'score',\s*(\d+),\s*'(\w+)'/g),
].map(([, key, threshold, name]) => ({ key, name, threshold: Number(threshold), hint: null }));

const tier = (name: string) => {
  const found = seededTiers.find((t) => t.name === name);
  if (!found) throw new Error(`no seeded tier ${name}`);
  return found;
};

describe('buildCreatorScoreLadder', () => {
  it('reads all nine seeded tiers', () => {
    expect(seededTiers.map((t) => t.name)).toEqual([
      'Spark',
      'Kindle',
      'Flame',
      'Blaze',
      'Beacon',
      'Nova',
      'Star',
      'Supernova',
      'Legend',
    ]);
  });

  it('gives each tier the unlocks above the previous tier up to its own threshold', () => {
    const rungs = buildCreatorScoreLadder(unlocks, seededTiers);
    const keysAt = (name: string) =>
      rungs.find((r) => r.tier?.name === name)?.unlocks.map((u) => u.key) ?? [];

    expect(keysAt('Spark')).toEqual(['crucible-judge']);
    expect(keysAt('Flame')).toContain('challenge-create');
    expect(keysAt('Blaze')).toContain('monetize-pricing');
    expect(keysAt('Beacon')).toContain('creator-program');
    expect(keysAt('Legend')).toEqual([]);

    for (const [index, rung] of rungs.entries()) {
      const floor = index > 0 ? rungs[index - 1].minScore : -Infinity;
      for (const u of rung.unlocks) {
        expect(u.minScore).toBeGreaterThan(floor);
        expect(u.minScore).toBeLessThanOrEqual(rung.minScore);
      }
    }
  });

  it('places every unlock exactly once, the daily article limits included', () => {
    const placed = buildCreatorScoreLadder(unlocks, seededTiers).flatMap((r) =>
      r.unlocks.map((u) => u.key)
    );

    expect([...placed].sort()).toEqual(unlocks.map((u) => u.key).sort());
    expect(placed.filter((key) => key.startsWith('daily-articles:'))).toHaveLength(
      dailyArticleTiers.length
    );
  });

  it('falls back to one unnamed rung per threshold when no tiers exist', () => {
    const rungs = buildCreatorScoreLadder(unlocks, []);
    const thresholds = [...new Set(unlocks.map((u) => u.minScore))].sort((a, b) => a - b);

    expect(rungs.map((r) => r.minScore)).toEqual(thresholds);
    expect(rungs.every((r) => r.tier === null)).toBe(true);
  });

  it('keeps unlocks above the top tier as unnamed rungs instead of dropping them', () => {
    const rungs = buildCreatorScoreLadder(unlocks, [tier('Spark')]);
    expect(rungs[0].tier?.name).toBe('Spark');
    expect(rungs.slice(1).every((r) => r.tier === null)).toBe(true);
    expect(rungs.flatMap((r) => r.unlocks).map((u) => u.key)).toContain('creator-program');
  });
});

describe('nextCreatorScoreRung and currentCreatorScoreTier', () => {
  const rungs = buildCreatorScoreLadder(unlocks, seededTiers);

  it('is the next rung strictly above the score, and the tier at or below it', () => {
    const flame = tier('Flame').threshold;
    expect(nextCreatorScoreRung(rungs, flame - 1)?.tier?.name).toBe('Flame');
    expect(nextCreatorScoreRung(rungs, flame)?.tier?.name).toBe('Blaze');
    expect(currentCreatorScoreTier(rungs, flame - 1)?.name).toBe('Kindle');
    expect(currentCreatorScoreTier(rungs, flame)?.name).toBe('Flame');
  });

  it('has no tier below the first, and no next rung past the top', () => {
    expect(currentCreatorScoreTier(rungs, tier('Spark').threshold - 1)).toBeNull();
    expect(nextCreatorScoreRung(rungs, tier('Legend').threshold)).toBeNull();
  });
});

describe('creatorScoreGateState', () => {
  const gate = (score: number | null | undefined, required: number, tiers = seededTiers) =>
    creatorScoreGateState({ score, required, unlocks, tiers });

  it('tells an unknown score apart from no score', () => {
    expect(gate(undefined, CHALLENGE_MIN_CREATOR_SCORE).kind).toBe('unknown');
    expect(gate(null, CHALLENGE_MIN_CREATOR_SCORE).kind).toBe('unknown');
    expect(gate(0, CHALLENGE_MIN_CREATOR_SCORE).kind).toBe('noScore');
  });

  // A score pushed below zero by removed content is not "no score yet".
  it('gives a negative score the nearest rung, not the no-score copy', () => {
    expect(gate(-40, CHALLENGE_MIN_CREATOR_SCORE)).toMatchObject({
      kind: 'far',
      score: -40,
      next: { minScore: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE },
    });
  });

  it('climbs the ladder from the total when the gate compares another score', () => {
    const state = creatorScoreGateState({
      score: 4_000,
      total: 1,
      required: 40_000,
      unlocks,
      tiers: seededTiers,
    });
    // Says the total, the number the named step is measured from.
    expect(state).toMatchObject({ kind: 'far', score: 1, next: { tier: { name: 'Spark' } } });
  });

  it('judges an aggregate-score unlock on the aggregate when naming the next step', () => {
    const [base] = unlocks;
    const synthetic = [
      { ...base, key: 'aggregate-step', minScore: 300, scoreKind: 'aggregate' as const },
      { ...base, key: 'total-step', minScore: 600, scoreKind: 'total' as const },
    ];
    const state = creatorScoreGateState({
      score: 400,
      total: 100,
      required: 1_000,
      unlocks: synthetic,
      tiers: [],
    });
    expect(state).toMatchObject({ kind: 'far', next: { minScore: 600 } });
  });

  it('reports a met requirement as met, at and above the gate', () => {
    expect(gate(CHALLENGE_MIN_CREATOR_SCORE, CHALLENGE_MIN_CREATOR_SCORE)).toEqual({
      kind: 'met',
      score: CHALLENGE_MIN_CREATOR_SCORE,
    });
    expect(gate(CHALLENGE_MIN_CREATOR_SCORE - 1, CHALLENGE_MIN_CREATOR_SCORE).kind).not.toBe('met');
  });

  // Near and met measure against the gate, so they state the gate's own score, not the total.
  it('states the compared score, not the total, when near or past an aggregate gate', () => {
    const at = (score: number) =>
      creatorScoreGateState({
        score,
        total: 30_000,
        required: 50_000,
        unlocks,
        tiers: seededTiers,
      });

    expect(at(45_000)).toEqual({ kind: 'near', score: 45_000, gap: 5_000 });
    expect(at(52_000)).toEqual({ kind: 'met', score: 52_000 });
  });

  // The monetize gate clamps a negative score to 0 before it reaches the message.
  it('does not call a clamped negative score "no score yet"', () => {
    const state = creatorScoreGateState({
      score: 0,
      total: -40,
      required: CHALLENGE_MIN_CREATOR_SCORE,
      unlocks,
      tiers: seededTiers,
    });
    expect(state).toMatchObject({ kind: 'far', score: -40 });
  });

  it('switches from the nearest rung to the gap at 80% of the gate', () => {
    const [base] = unlocks;
    const synthetic = [
      { ...base, key: 'below-gate', minScore: 900 },
      { ...base, key: 'gate', minScore: 1000 },
    ];
    const at = (score: number) =>
      creatorScoreGateState({ score, required: 1000, unlocks: synthetic, tiers: [] });

    expect(at(800)).toEqual({ kind: 'near', score: 800, gap: 200 });
    expect(at(799)).toMatchObject({ kind: 'far', next: { minScore: 900 } });
  });

  it('points someone far below a gate at the nearest unlock, named by its tier', () => {
    const state = gate(1, CHALLENGE_MIN_CREATOR_SCORE);
    if (state.kind !== 'far') throw new Error(`expected far, got ${state.kind}`);

    expect(state.next.minScore).toBe(CRUCIBLE_JUDGE_MIN_CREATOR_SCORE);
    expect(state.next.tier?.name).toBe('Spark');
    expect(state.next.unlocks.map((u) => u.key)).toEqual(['crucible-judge']);
  });

  it('leaves the rung unnamed when no tier sits on it', () => {
    const state = gate(1, CHALLENGE_MIN_CREATOR_SCORE, []);
    if (state.kind !== 'far') throw new Error(`expected far, got ${state.kind}`);
    expect(state.next.tier).toBeNull();
  });

  it('states the gap when the nearest unlock is the gate itself', () => {
    const required = CRUCIBLE_JUDGE_MIN_CREATOR_SCORE;
    expect(gate(1, required)).toEqual({ kind: 'near', score: 1, gap: required - 1 });
  });
});

describe('describeCreatorScoreUnlocks', () => {
  it('joins the labels as one clause', () => {
    const [a, b, c] = unlocks;
    const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

    expect(describeCreatorScoreUnlocks([a])).toBe(lower(a.label));
    expect(describeCreatorScoreUnlocks([a, b, c])).toBe(
      `${lower(a.label)}, ${lower(b.label)}, and ${lower(c.label)}`
    );
  });
});

describe('groupCreatorScoreUnlocks', () => {
  it('collapses one privilege repeated per surface at a threshold into one line naming every surface', () => {
    const priceCaps = unlocks.filter((u) => u.key.startsWith('placement-price-cap:'));
    const threshold = priceCaps[0].minScore;
    const atThreshold = priceCaps.filter((u) => u.minScore === threshold);
    expect(atThreshold).toHaveLength(placementSurfaces.length);

    const groups = groupCreatorScoreUnlocks(atThreshold);

    expect(groups).toHaveLength(1);
    expect(groups[0].unlocks).toHaveLength(placementSurfaces.length);
    for (const surface of placementSurfaces)
      expect(groups[0].label).toContain(placementSurfaceLabel(surface));
  });

  it('keeps different privileges and different thresholds apart', () => {
    const groups = groupCreatorScoreUnlocks(unlocks);
    expect(groups.flatMap((g) => g.unlocks)).toHaveLength(unlocks.length);
    for (const group of groups) {
      expect(new Set(group.unlocks.map((u) => u.minScore)).size).toBe(1);
      expect(new Set(group.unlocks.map((u) => u.key.split(':')[0])).size).toBe(1);
    }
  });

  it('does not merge a family whose labels do not share a prefix', () => {
    const [base] = unlocks;
    const groups = groupCreatorScoreUnlocks([
      { ...base, key: 'x:1', label: 'Alpha on one' },
      { ...base, key: 'x:2', label: 'Beta on two' },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Alpha on one', 'Beta on two']);
  });
});

describe('pendingCreatorScoreUnlocks', () => {
  it('judges each unlock on its own kind of score', () => {
    const creatorProgram = unlocks.find((u) => u.key === 'creator-program');
    if (!creatorProgram) throw new Error('no creator-program unlock');
    const rung = { minScore: creatorProgram.minScore, tier: null, unlocks: [creatorProgram] };

    expect(
      pendingCreatorScoreUnlocks(rung, { total: 0, aggregate: creatorProgram.minScore })
    ).toEqual([]);
    expect(pendingCreatorScoreUnlocks(rung, { total: creatorProgram.minScore - 1 })).toEqual([
      creatorProgram,
    ]);
  });
});
