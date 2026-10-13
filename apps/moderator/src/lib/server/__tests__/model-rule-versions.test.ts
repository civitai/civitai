import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);
const params = vi.hoisted(() => [] as unknown[][]);
const answers = vi.hoisted(() => ({
  rule: [] as unknown[],
  history: [] as unknown[],
  version: [] as unknown[],
}));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const answer = (sql: string) => {
    if (sql.includes('from "ModerationRule"') && sql.endsWith('for update')) return answers.rule;
    if (sql.includes('from "ModerationRuleVersion"'))
      return sql.startsWith('select "id"') ? answers.history : answers.version;
    return [{ id: 7 }];
  };
  const db = capturingDb(captured, answer, params);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(), recordModActivityBatch: vi.fn() }));
vi.mock('../cache', () => ({ bustKeyBestEffort: vi.fn(async () => true) }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn(async () => new Map()) }));

const {
  ModelRuleStaleError,
  ModelRuleVersionNotFoundError,
  RestoreRefusedError,
  createModelRule,
  listModelRuleVersions,
  restoreModelRuleVersion,
  setModelRuleEnabled,
  updateModelRule,
} = await import('../model-rules.service');

const UPDATED = new Date('2026-09-01T10:00:00.000Z');
const SEMANTIC = {
  type: 'semantic',
  subject: 'Old subject',
  description: 'Old',
  aliases: ['Old alias'],
  updatedById: 42,
};
const RULE = {
  id: 7,
  definition: SEMANTIC,
  enabled: true,
  action: 'Block',
  reason: null,
  createdById: 3,
  updatedAt: UPDATED,
};
const FORM = { subject: 'New subject', description: 'New', aliases: ['New alias'], note: '' };
const versionInserts = () =>
  captured.flatMap((s, i) => (s.startsWith('insert into "ModerationRuleVersion"') ? [i] : []));

beforeEach(() => {
  captured.length = 0;
  params.length = 0;
  answers.rule = [RULE];
  answers.history = [];
  answers.version = [];
});

describe('updateModelRule', () => {
  it('records the pre-edit state first for a rule with no history, in one insert after the update', async () => {
    await updateModelRule(7, FORM, 5);

    expect(captured).toHaveLength(4);
    expect(captured[0]).toMatch(/from "ModerationRule" where .* for update$/);
    expect(captured[1]).toMatch(/^update "ModerationRule"/);
    expect(captured[2]).toBe(
      'select "id" from "ModerationRuleVersion" where "ruleId" = $1 limit $2'
    );
    expect(versionInserts()).toEqual([3]);
    expect(params[3]).toEqual([
      7,
      SEMANTIC,
      true,
      'Block',
      null,
      42,
      UPDATED,
      7,
      expect.objectContaining({ subject: 'New subject', aliases: ['New alias'], updatedById: 5 }),
      true,
      'Block',
      null,
      5,
    ]);
  });

  it('records only the new state when the rule already has history', async () => {
    answers.history = [{ id: 1 }];
    await updateModelRule(7, FORM, 5);
    expect(versionInserts()).toEqual([3]);
    expect(params[3]).toHaveLength(6);
    expect(params[3][5]).toBe(5);
  });

  it('refuses a draft whose rule changed since it started, before writing anything', async () => {
    await expect(
      updateModelRule(7, FORM, 5, { baseUpdatedAt: '2026-01-01T00:00:00.000Z' })
    ).rejects.toBeInstanceOf(ModelRuleStaleError);
    expect(captured).toHaveLength(1);
  });

  it('accepts a draft written against the current rule', async () => {
    await updateModelRule(7, FORM, 5, { baseUpdatedAt: UPDATED.toISOString() });
    expect(versionInserts()).toHaveLength(1);
  });
});

describe('createModelRule', () => {
  it('inserts the rule and its first version in one transaction', async () => {
    await createModelRule(FORM, 5);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatch(/^insert into "ModerationRule"/);
    expect(captured[1]).toMatch(/^insert into "ModerationRuleVersion"/);
    expect(params[1]).toEqual([
      7,
      expect.objectContaining({ subject: 'New subject' }),
      true,
      'Block',
      null,
      5,
    ]);
  });
});

describe('setModelRuleEnabled', () => {
  it('versions the toggle', async () => {
    answers.history = [{ id: 1 }];
    await setModelRuleEnabled(7, false, 5);
    expect(versionInserts()).toHaveLength(1);
    expect(params[versionInserts()[0]][2]).toBe(false);
  });
});

describe('restoreModelRuleVersion', () => {
  const OLD = {
    definition: { ...SEMANTIC, subject: 'Older subject', updatedById: 9 },
    enabled: false,
    reason: 'old note',
  };

  it('writes the old definition and enabled state as the rule and as a new version', async () => {
    answers.history = [{ id: 1 }];
    answers.version = [OLD];
    await restoreModelRuleVersion(7, 2, 5);
    expect(captured[1]).toBe(
      'select "definition", "enabled", "reason" from "ModerationRuleVersion" where "id" = $1 and "ruleId" = $2'
    );
    expect(params[1]).toEqual([2, 7]);
    expect(captured[2]).toMatch(/^update "ModerationRule"/);
    const insert = versionInserts()[0];
    expect(params[insert]).toEqual([
      7,
      expect.objectContaining({ subject: 'Older subject', updatedById: 5 }),
      false,
      'Block',
      'old note',
      5,
    ]);
  });

  it('refuses a version of another rule', async () => {
    answers.version = [];
    await expect(restoreModelRuleVersion(7, 2, 5)).rejects.toBeInstanceOf(
      ModelRuleVersionNotFoundError
    );
    expect(captured.some((s) => s.startsWith('update'))).toBe(false);
  });

  it('refuses a version identical to the current rule', async () => {
    answers.version = [{ definition: SEMANTIC, enabled: true, reason: null }];
    await expect(restoreModelRuleVersion(7, 2, 5)).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(captured.some((s) => s.startsWith('update'))).toBe(false);
  });

  it('refuses a regex version', async () => {
    answers.version = [{ definition: { match: 'x' }, enabled: true, reason: null }];
    await expect(restoreModelRuleVersion(7, 2, 5)).rejects.toBeInstanceOf(RestoreRefusedError);
  });
});

describe('listModelRuleVersions', () => {
  it('reads Model rule versions only, newest first', async () => {
    answers.version = [];
    await listModelRuleVersions(7);
    expect(captured[0]).toMatch(/inner join "ModerationRule" as "r" on "r"."id" = "v"."ruleId"/);
    expect(captured[0]).toMatch(/"r"."entityType" = \$2/);
    expect(captured[0]).toMatch(/order by "v"."id" desc limit \$3$/);
    expect(params[0]).toEqual([7, 'Model', 50]);
  });
});
