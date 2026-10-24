import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RulesService from '$lib/server/model-rules.service';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/cache', () => ({ bustKeyBestEffort: vi.fn(async () => true) }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
const axiom = vi.hoisted(() => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/axiom', () => axiom);

const tryRun = vi.hoisted(() => vi.fn());
vi.mock('../literal-try.server', () => ({ runLiteralTry: tryRun }));
const service = vi.hoisted(() => ({
  createModelRule: vi.fn(),
  updateModelRule: vi.fn(),
  setModelRuleEnabled: vi.fn(),
  restoreModelRuleVersion: vi.fn(),
  listModelRules: vi.fn(),
  countNotSubjectDismissalsByRule: vi.fn(),
}));
const suggest = vi.hoisted(() => ({
  runSuggestAliases: vi.fn(),
  runAliasSuggestionResult: vi.fn(),
}));
vi.mock('../suggest-aliases.server', () => suggest);
vi.mock('$lib/server/model-rules.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RulesService>()),
  ...service,
}));

const { actions, load } = await import('../+page.server');
const { ModelRuleStaleError, RestoreRefusedError, RuleNeedsReviewError } = await import(
  '$lib/server/model-rules.service'
);

const EDIT = { 'textScan.modelRules.edit': true };
type Action = keyof typeof actions;
const post = (
  action: Action,
  fields: Record<string, string>,
  grants: Record<string, boolean> = EDIT
) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1 }, grants },
  } as unknown as Parameters<(typeof actions)['save']>[0];
  return (actions[action] as (e: typeof event) => Promise<unknown>)(event) as Promise<
    Record<string, unknown>
  >;
};

beforeEach(() => {
  vi.clearAllMocks();
  service.countNotSubjectDismissalsByRule.mockResolvedValue({});
});

describe('permissions', () => {
  it.each([
    'save',
    'saveAll',
    'toggle',
    'restoreRule',
    'suggestAliases',
    'aliasSuggestionResult',
  ] as const)(
    '%s returns 403 without textScan.modelRules.edit, even with the prompt publish permission',
    async (action) => {
      expect(await post(action, {}, { 'textScan.prompt.publish': true })).toMatchObject({
        status: 403,
      });
      for (const fn of [...Object.values(service), ...Object.values(suggest)])
        expect(fn).not.toHaveBeenCalled();
    }
  );
});

describe('save', () => {
  it('passes the version the draft started from', async () => {
    service.updateModelRule.mockResolvedValue({ cacheStale: false });
    await post('save', {
      id: '3',
      subject: 'Example',
      aliases: 'One\nTwo',
      baseUpdatedAt: '2026-09-01T10:00:00.000Z',
    });
    expect(service.updateModelRule).toHaveBeenCalledWith(
      3,
      { subject: 'Example', description: '', aliases: ['One', 'Two'], note: '' },
      1,
      { baseUpdatedAt: '2026-09-01T10:00:00.000Z' }
    );
  });

  it('returns 409 for a draft written against an older rule', async () => {
    service.updateModelRule.mockRejectedValue(new ModelRuleStaleError());
    expect(await post('save', { id: '3', subject: 'Example', baseUpdatedAt: 'x' })).toMatchObject({
      status: 409,
    });
  });

  it('creates a rule when there is no id, and returns the new id', async () => {
    service.createModelRule.mockResolvedValue({ id: 11, cacheStale: false });
    expect(await post('save', { subject: 'New' })).toMatchObject({ success: true, id: 11 });
  });
});

describe('saveAll', () => {
  it('saves every valid draft and reports the rest by draft id', async () => {
    service.createModelRule.mockResolvedValue({ id: 11, cacheStale: false });
    service.updateModelRule.mockRejectedValue(new ModelRuleStaleError());
    const rules = [
      { draftId: -1, subject: 'New', description: '', aliases: '', note: '' },
      {
        draftId: 3,
        id: 3,
        subject: 'Example',
        description: '',
        aliases: '',
        note: '',
        baseUpdatedAt: 'x',
      },
      { draftId: -2, subject: '   ', description: '', aliases: 'X', note: '' },
    ];
    expect(await post('saveAll', { rules: JSON.stringify(rules) })).toMatchObject({
      status: 422,
      data: {
        saved: [{ draftId: -1, id: 11 }],
        failed: [{ draftId: 3 }, { draftId: -2, error: 'Subject is required.' }],
      },
    });
  });

  it('succeeds when every draft saved', async () => {
    service.createModelRule.mockResolvedValue({ id: 11, cacheStale: false });
    const rules = [{ draftId: -1, subject: 'New', description: '', aliases: '', note: '' }];
    expect(await post('saveAll', { rules: JSON.stringify(rules) })).toMatchObject({
      success: true,
      saved: [{ draftId: -1, id: 11 }],
    });
  });
});

describe('saveAll as the alias approval path', () => {
  it('appends to each rule against its saved version and reports a stale rule by id', async () => {
    service.updateModelRule
      .mockResolvedValueOnce({ cacheStale: false })
      .mockRejectedValueOnce(new ModelRuleStaleError());
    const base = { subject: 'Example', description: '', note: '', baseUpdatedAt: 't1' };
    const rules = [
      { ...base, draftId: 3, id: 3, aliases: 'Old\nNew' },
      { ...base, draftId: 4, id: 4, aliases: 'Other' },
    ];
    expect(await post('saveAll', { rules: JSON.stringify(rules) })).toMatchObject({
      status: 422,
      data: { saved: [{ draftId: 3, id: 3 }], failed: [{ draftId: 4 }] },
    });
    expect(service.updateModelRule).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ aliases: ['Old', 'New'] }),
      1,
      { baseUpdatedAt: 't1' }
    );
  });
});

describe('restoreRule', () => {
  it('refuses a restore that would change nothing', async () => {
    service.restoreModelRuleVersion.mockRejectedValue(new RestoreRefusedError('same'));
    expect(await post('restoreRule', { ruleId: '3', versionId: '2' })).toMatchObject({
      status: 400,
    });
  });
});

describe('restoreRule messages', () => {
  it('names a plain restore', async () => {
    service.restoreModelRuleVersion.mockResolvedValue({ cacheStale: false, flagged: false });
    expect(await post('restoreRule', { ruleId: '3', versionId: '2' })).toMatchObject({
      message: 'Restored rule 3.',
    });
  });

  it('says a flagged version came back needing review and disabled', async () => {
    service.restoreModelRuleVersion.mockResolvedValue({ cacheStale: false, flagged: true });
    expect(await post('restoreRule', { ruleId: '3', versionId: '2' })).toMatchObject({
      message: 'Restored rule 3 as needing review (disabled).',
    });
  });
});

describe('try', () => {
  it('runs the literal try with only the page grant', async () => {
    tryRun.mockResolvedValue({ tried: true });
    expect(await post('try', { input: 'some model text' }, {})).toEqual({ tried: true });
    expect(tryRun).toHaveBeenCalledOnce();
  });
});

describe('saveAll refusals', () => {
  const draft = (draftId: number, id?: number) => ({
    draftId,
    ...(id ? { id } : {}),
    subject: `Rule ${draftId}`,
    description: '',
    aliases: '',
    note: '',
  });

  it('reports an unexpected error for one rule and keeps saving the rest', async () => {
    service.createModelRule.mockResolvedValue({ id: 11, cacheStale: false });
    service.updateModelRule.mockRejectedValue(new Error('connection reset'));
    const rules = [draft(-1), draft(3, 3), draft(-2)];
    expect(await post('saveAll', { rules: JSON.stringify(rules) })).toMatchObject({
      status: 422,
      data: {
        saved: [
          { draftId: -1, id: 11 },
          { draftId: -2, id: 11 },
        ],
        failed: [{ draftId: 3, error: expect.stringContaining('unexpected error') }],
      },
    });
    expect(axiom.logAxiomError).toHaveBeenCalledOnce();
  });

  it('refuses an id beyond int4 before writing anything', async () => {
    const rules = [draft(-1), draft(2147483648, 2147483648)];
    expect(await post('saveAll', { rules: JSON.stringify(rules) })).toMatchObject({
      status: 400,
    });
    expect(service.createModelRule).not.toHaveBeenCalled();
    expect(service.updateModelRule).not.toHaveBeenCalled();
  });
});

describe('toggle', () => {
  it('disables a rule and reports it', async () => {
    service.setModelRuleEnabled.mockResolvedValue({ cacheStale: false });
    expect(await post('toggle', { id: '3', enabled: 'false' })).toEqual({
      success: true,
      message: 'Rule 3 disabled.',
      cacheWarning: null,
    });
    expect(service.setModelRuleEnabled).toHaveBeenCalledExactlyOnceWith(3, false, 1);
  });

  it('answers a flagged rule with the review message, not a toast of success', async () => {
    service.setModelRuleEnabled.mockRejectedValue(new RuleNeedsReviewError());
    const result = await post('toggle', { id: '3', enabled: 'true' });
    expect(result).toMatchObject({
      status: 409,
      data: { error: 'Review and save this rule before enabling it.' },
    });
  });
});

describe('suggestAliases', () => {
  it('hands the form to the suggester for a moderator who can edit rules', async () => {
    suggest.runSuggestAliases.mockResolvedValue({
      suggested: true,
      status: 'done',
      suggestions: [],
    });
    expect(await post('suggestAliases', { subject: 'Example' })).toEqual({
      suggested: true,
      status: 'done',
      suggestions: [],
    });
    expect(suggest.runSuggestAliases).toHaveBeenCalledTimes(1);
  });

  it('hands a poll to the result reader', async () => {
    suggest.runAliasSuggestionResult.mockResolvedValue({ suggested: true, status: 'pending' });
    expect(
      await post('aliasSuggestionResult', { workflowId: 'wf_0123456789', subject: 'Example' })
    ).toEqual({
      suggested: true,
      status: 'pending',
    });
    expect(suggest.runAliasSuggestionResult).toHaveBeenCalledTimes(1);
  });
});

describe('load', () => {
  it('returns the not-this-subject dismissal counts by rule', async () => {
    service.listModelRules.mockResolvedValue([]);
    service.countNotSubjectDismissalsByRule.mockResolvedValue({ 3: 2 });
    const data = (await load({
      url: new URL('http://x/text-scan/model-rules'),
    } as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
    expect(data.dismissals).toEqual({ 3: 2 });
  });

  it('still lists the rules when the dismissal counts fail', async () => {
    service.listModelRules.mockResolvedValue([{ id: 3 }]);
    service.countNotSubjectDismissalsByRule.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = (await load({
      url: new URL('http://x/text-scan/model-rules'),
    } as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
    expect(data).toMatchObject({ rules: [{ id: 3 }], dismissals: {} });
  });

  it('lists the rules with the filters from the url', async () => {
    const rule = { id: 3, subject: 'Example' };
    service.listModelRules.mockResolvedValue([rule]);
    const data = (await load({
      url: new URL('http://x/text-scan/model-rules?q=ex&status=disabled'),
    } as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
    expect(data).toMatchObject({ rules: [rule], query: { q: 'ex', status: 'disabled' } });
  });

  it('falls back to all rules for an unknown status', async () => {
    service.listModelRules.mockResolvedValue([]);
    const data = (await load({
      url: new URL('http://x/text-scan/model-rules?status=nope&tab=matches'),
    } as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
    expect(data.query).toEqual({ q: '', status: 'all' });
  });
});
