import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { userScoreUpdateSql } from '~/server/jobs/update-user-score';
import { userScoreMetaSchema } from '~/server/schema/user.schema';
import {
  CREATOR_SCORE_CATEGORIES,
  creatorAggregateScoreFromMeta,
} from '~/shared/utils/creator-score';

/**
 * Every place that sums the Creator Score categories must sum the same ones. A category missing from
 * one makes that gate disagree with the total the user is shown.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('the Creator Score category list', () => {
  it.each(CREATOR_SCORE_CATEGORIES)('the nightly total sums %s', (category) => {
    expect(userScoreUpdateSql([['1', {}]])).toContain(
      `COALESCE((s.scores->>'${category}')::numeric, (u.meta->'scores'->>'${category}')::numeric, 0)`
    );
  });

  it('Creator Studio keeps the same list', () => {
    const source = read('apps/creator-studio/src/lib/server/creator-score.ts');
    const list = source.match(/const SCORE_KEYS = \[([\s\S]*?)\] as const;/)?.[1];
    expect(list?.match(/'(\w+)'/g)?.map((key) => key.slice(1, -1))).toEqual([
      ...CREATOR_SCORE_CATEGORIES,
    ]);
  });

  it('the meta schema accepts every category', () => {
    expect(Object.keys(userScoreMetaSchema.shape)).toEqual(
      expect.arrayContaining([...CREATOR_SCORE_CATEGORIES])
    );
  });

  it('the aggregate gate counts a staff award', () => {
    expect(
      creatorAggregateScoreFromMeta({ scores: { total: 0, models: 100, staffAwarded: 400 } })
    ).toBe(500);
  });
});
