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
const bust = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('../cache', () => ({ bustKeyBestEffort: bust }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn(async () => new Map()) }));

const { REDIS_KEYS } = await import('@civitai/redis');
const {
  ModelRuleStaleError,
  RuleNeedsReviewError,
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
const REFS = [{ url: 'https://example.com/ref', label: 'Official art' }];
const FORM = {
  subject: 'New subject',
  description: 'New',
  aliases: ['New alias'],
  category: 'ip' as const,
  references: REFS,
  note: '',
};
const versionInserts = () =>
  captured.flatMap((s, i) => (s.startsWith('insert into "ModerationRuleVersion"') ? [i] : []));

beforeEach(() => {
  bust.mockClear();
  bust.mockResolvedValue(true);
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
      expect.objectContaining({
        subject: 'New subject',
        aliases: ['New alias'],
        category: 'ip',
        references: REFS,
        updatedById: 5,
      }),
      true,
      'Block',
      null,
      5,
    ]);
  });

  it('keeps a stored category and references when the rule is toggled', async () => {
    answers.rule = [
      { ...RULE, definition: { ...SEMANTIC, category: 'artist', references: REFS } },
    ];
    await setModelRuleEnabled(7, false, 5);
    expect(params[1]).toContainEqual(
      expect.objectContaining({ category: 'artist', references: REFS })
    );
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

  it('restores a flagged version flagged, and disabled so it is never enabled-but-unscanned', async () => {
    answers.history = [{ id: 1 }];
    answers.version = [
      { ...OLD, enabled: true, definition: { ...OLD.definition, needsAttention: true } },
    ];
    await restoreModelRuleVersion(7, 2, 5);
    const update = captured.findIndex((s) => s.startsWith('update "ModerationRule"'));
    const insert = versionInserts()[0];
    expect(params[update][0]).toMatchObject({ subject: 'Older subject', needsAttention: true });
    expect(params[update][1]).toBe(false);
    expect(params[insert][1]).toMatchObject({ needsAttention: true });
    expect(params[insert][2]).toBe(false);
  });

  it('records the pre-restore state first when the rule has no history', async () => {
    answers.history = [];
    answers.version = [OLD];
    await restoreModelRuleVersion(7, 2, 5);
    const insert = versionInserts()[0];
    expect(params[insert]).toEqual([
      7,
      SEMANTIC,
      true,
      'Block',
      null,
      42,
      UPDATED,
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

  it('refuses a flagged version when the rule already sits flagged and disabled', async () => {
    answers.rule = [
      {
        ...RULE,
        enabled: false,
        definition: { ...SEMANTIC, needsAttention: true },
      },
    ];
    answers.version = [
      { definition: { ...SEMANTIC, needsAttention: true }, enabled: true, reason: null },
    ];
    await expect(restoreModelRuleVersion(7, 2, 5)).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(captured.some((s) => s.startsWith('update') || s.startsWith('insert'))).toBe(false);
  });

  it('says whether the restored rule came back flagged', async () => {
    answers.history = [{ id: 1 }];
    answers.version = [
      { ...OLD, enabled: true, definition: { ...OLD.definition, needsAttention: true } },
    ];
    expect(await restoreModelRuleVersion(7, 2, 5)).toMatchObject({ flagged: true });
    answers.version = [OLD];
    expect(await restoreModelRuleVersion(7, 2, 5)).toMatchObject({ flagged: false });
  });

  it('refuses a version that no longer fits the rule schema', async () => {
    answers.version = [{ ...OLD, definition: { ...OLD.definition, aliases: ['  '] } }];
    await expect(restoreModelRuleVersion(7, 2, 5)).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(captured.some((s) => s.startsWith('update') || s.startsWith('insert'))).toBe(false);
  });

  it('refuses a regex version', async () => {
    answers.version = [{ definition: { match: 'x' }, enabled: true, reason: null }];
    await expect(restoreModelRuleVersion(7, 2, 5)).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(captured.some((s) => s.startsWith('update') || s.startsWith('insert'))).toBe(false);
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

describe('a hand-written bad category or reference', () => {
  it('never reaches the version view', async () => {
    answers.version = [
      {
        id: 1,
        definition: {
          ...SEMANTIC,
          category: 'bogus',
          references: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/ok' }],
        },
        enabled: true,
        reason: null,
        createdById: 3,
        createdAt: UPDATED,
      },
    ];
    const [view] = await listModelRuleVersions(7);
    expect(view.category).toBeUndefined();
    expect(view.references).toEqual([{ url: 'https://example.com/ok' }]);
  });
});

describe('a rule that needs attention', () => {
  const FLAGGED = {
    ...RULE,
    enabled: false,
    definition: { ...SEMANTIC, needsAttention: true, legacyMatch: '/jane/i' },
  };
  const UNCHANGED = {
    subject: 'Old subject',
    description: 'Old',
    aliases: ['Old alias'],
    category: undefined,
    references: [],
    note: '',
  };

  it('cannot be enabled until a person has reviewed it', async () => {
    answers.rule = [FLAGGED];
    await expect(setModelRuleEnabled(7, true, 5)).rejects.toThrow(
      'Review and save this rule before enabling it.'
    );
    await expect(setModelRuleEnabled(7, true, 5)).rejects.toBeInstanceOf(RuleNeedsReviewError);
    expect(captured.some((s) => s.startsWith('update') || s.startsWith('insert'))).toBe(false);
    expect(bust).not.toHaveBeenCalled();
  });

  it('can still be disabled', async () => {
    answers.rule = [{ ...FLAGGED, enabled: true }];
    answers.history = [{ id: 1 }];
    await setModelRuleEnabled(7, false, 5);
    expect(versionInserts()).toHaveLength(1);
  });

  it('is reviewed by saving it unchanged: the flag clears, legacyMatch stays, a version is recorded', async () => {
    answers.rule = [FLAGGED];
    answers.history = [{ id: 1 }];
    await updateModelRule(7, UNCHANGED, 5);
    const update = captured.findIndex((s) => s.startsWith('update "ModerationRule"'));
    const written = params[update][0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('needsAttention');
    expect(written).toMatchObject({ subject: 'Old subject', legacyMatch: '/jane/i' });
    expect(versionInserts()).toHaveLength(1);
    expect(params[versionInserts()[0]][1]).not.toHaveProperty('needsAttention');
  });

  it('can be enabled once reviewed', async () => {
    answers.rule = [
      { ...FLAGGED, definition: { ...FLAGGED.definition, needsAttention: undefined } },
    ];
    answers.history = [{ id: 1 }];
    await setModelRuleEnabled(7, true, 5);
    expect(params[versionInserts()[0]][2]).toBe(true);
  });
});

describe('every rule write clears the Model rules cache', () => {
  const KEY = REDIS_KEYS.CACHES.MOD_RULES.MODELS;
  const writes: [string, () => Promise<{ cacheStale: boolean }>][] = [
    ['createModelRule', () => createModelRule(FORM, 5)],
    ['updateModelRule', () => updateModelRule(7, FORM, 5)],
    ['setModelRuleEnabled', () => setModelRuleEnabled(7, false, 5)],
    [
      'restoreModelRuleVersion',
      async () => {
        answers.version = [
          { definition: { ...SEMANTIC, subject: 'Older' }, enabled: false, reason: null },
        ];
        return restoreModelRuleVersion(7, 2, 5);
      },
    ],
  ];

  it.each(writes)('%s busts the key and reports it fresh', async (_name, write) => {
    answers.history = [{ id: 1 }];
    expect(await write()).toMatchObject({ cacheStale: false });
    expect(bust).toHaveBeenCalledTimes(1);
    expect(bust.mock.calls[0][0]).toBe(KEY);
  });

  it.each(writes)('%s reports cacheStale when the bust fails', async (_name, write) => {
    answers.history = [{ id: 1 }];
    bust.mockResolvedValue(false);
    expect(await write()).toMatchObject({ cacheStale: true });
  });
});

describe('rule-write SQL', () => {
  const OLDER = { definition: { ...SEMANTIC, subject: 'Older' }, enabled: false, reason: null };
  const updates = () => captured.filter((s) => s.startsWith('update "ModerationRule"'));

  it('scopes every update to Model rules and sets updatedAt', async () => {
    answers.history = [{ id: 1 }];
    answers.version = [OLDER];
    await updateModelRule(7, FORM, 5);
    await setModelRuleEnabled(7, false, 5);
    await restoreModelRuleVersion(7, 2, 5);
    expect(updates()).toHaveLength(3);
    for (const sql of updates()) {
      expect(sql).toMatch(/"updatedAt" = \$\d+/);
      expect(sql).toMatch(/where "id" = \$\d+ and "entityType" = \$\d+$/);
    }
    const bound = captured.flatMap((s, i) =>
      s.startsWith('update "ModerationRule"') ? [params[i]] : []
    );
    for (const p of bound) expect(p.at(-1)).toBe('Model');
  });

  it('locks the rule row, scoped to Model, before any write', async () => {
    answers.history = [{ id: 1 }];
    await setModelRuleEnabled(7, false, 5);
    expect(captured[0]).toMatch(
      /from "ModerationRule" where "id" = \$1 and "entityType" = \$2 for update$/
    );
    expect(params[0]).toEqual([7, 'Model']);
  });

  it('writes the enabled value it was given', async () => {
    answers.history = [{ id: 1 }];
    await setModelRuleEnabled(7, false, 5);
    const update = captured.findIndex((s) => s.startsWith('update "ModerationRule"'));
    expect(captured[update]).toMatch(/set "enabled" = \$1,/);
    expect(params[update][0]).toBe(false);
  });

  it('keeps needsAttention and legacyMatch on a toggle, and records them in the version', async () => {
    const flagged = { ...SEMANTIC, needsAttention: true, legacyMatch: '/x/' };
    answers.rule = [{ ...RULE, enabled: true, definition: flagged }];
    answers.history = [{ id: 1 }];
    await setModelRuleEnabled(7, false, 5);
    const update = captured.findIndex((s) => s.startsWith('update "ModerationRule"'));
    const definition = params[update].find(
      (v) => typeof v === 'object' && v !== null && 'subject' in v
    );
    expect(definition).toMatchObject({ needsAttention: true, legacyMatch: '/x/', updatedById: 5 });
    expect(params[versionInserts()[0]][1]).toMatchObject({
      needsAttention: true,
      legacyMatch: '/x/',
    });
  });
});
