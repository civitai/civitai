import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import { CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import type { CreatorScoreTier } from '~/shared/utils/creator-score-unlocks';
import {
  buildCreatorScoreLadder,
  creatorScoreGateState,
  currentCreatorScoreTier,
  describeCreatorScoreUnlocks,
  nextCreatorScoreRung,
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

  it('places every total- and aggregate-score unlock exactly once, and no articles-score unlock', () => {
    const placed = buildCreatorScoreLadder(unlocks, seededTiers).flatMap((r) =>
      r.unlocks.map((u) => u.key)
    );
    const expected = unlocks.filter((u) => u.scoreKind !== 'articles').map((u) => u.key);

    expect([...placed].sort()).toEqual([...expected].sort());
    expect(unlocks.some((u) => u.scoreKind === 'articles')).toBe(true);
  });

  it('falls back to one unnamed rung per threshold when no tiers exist', () => {
    const rungs = buildCreatorScoreLadder(unlocks, []);
    const thresholds = [
      ...new Set(unlocks.filter((u) => u.scoreKind !== 'articles').map((u) => u.minScore)),
    ].sort((a, b) => a - b);

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
    expect(gate(-40, CHALLENGE_MIN_CREATOR_SCORE).kind).toBe('noScore');
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
      `${lower(a.label)}, ${lower(b.label)} and ${lower(c.label)}`
    );
  });
});
