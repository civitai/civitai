import { MODEL_RULES_RESULT_PG_PATHS } from '@civitai/moderation/model-rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);
const params = vi.hoisted(() => [] as unknown[][]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, () => [], params);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(), recordModActivityBatch: vi.fn() }));
vi.mock('../cache', () => ({ bustKeyBestEffort: vi.fn(async () => true) }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn(async () => new Map()) }));

const { getModelRuleMatches } = await import('../model-rules.service');

beforeEach(() => {
  captured.length = 0;
  params.length = 0;
});

describe('getModelRuleMatches rule filter', () => {
  it('reads model matches at the matched path and literal hits at the literalRuleIds path', async () => {
    await getModelRuleMatches({ mode: 'all', ruleId: 9, limit: 10 });
    const sql = captured[0];
    expect(sql).toContain(
      `em.result #> '${MODEL_RULES_RESULT_PG_PATHS.matched}' @> $1::jsonb OR em.result #> '${MODEL_RULES_RESULT_PG_PATHS.literalRuleIds}' @> $2::jsonb`
    );
    expect(params[0].slice(0, 2)).toEqual([JSON.stringify([{ ruleId: 9 }]), JSON.stringify([9])]);
  });

  it('adds no rule filter when none is asked for', async () => {
    await getModelRuleMatches({ mode: 'all', limit: 10 });
    expect(captured[0]).not.toContain(MODEL_RULES_RESULT_PG_PATHS.literalRuleIds);
  });
});
