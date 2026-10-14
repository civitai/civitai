import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RulesService from '$lib/server/model-rules.service';
import type * as HarnessClient from '$lib/server/text-scan-lab/harness-client';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/cache', () => ({ bustKeyBestEffort: vi.fn(async () => true) }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/civitai-url', () => ({ civitaiLinkUrl: () => 'https://civitai.com' }));
const axiom = vi.hoisted(() => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/axiom', () => axiom);

const harness = vi.hoisted(() => ({
  getPrompts: vi.fn(),
  putPrompt: vi.fn(),
  scanTexts: vi.fn(),
  composeEntities: vi.fn(),
}));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));
const service = vi.hoisted(() => ({
  createModelRule: vi.fn(),
  updateModelRule: vi.fn(),
  setModelRuleEnabled: vi.fn(),
  restoreModelRuleVersion: vi.fn(),
  listModelRules: vi.fn(),
}));
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
});

describe('permissions', () => {
  it.each(['save', 'saveAll', 'toggle', 'restoreRule', 'savePolicy', 'restorePolicy'] as const)(
    '%s returns 403 without textScan.modelRules.edit, even with the prompt publish permission',
    async (action) => {
      expect(await post(action, {}, { 'textScan.prompt.publish': true })).toMatchObject({
        status: 403,
      });
      for (const fn of [...Object.values(service), harness.putPrompt])
        expect(fn).not.toHaveBeenCalled();
    }
  );
});

describe('savePolicy', () => {
  it('saves the Model rules policy whatever key the form names', async () => {
    harness.putPrompt.mockResolvedValue({ id: 9, key: 'label:modelRules' });
    expect(await post('savePolicy', { key: 'base', content: 'POLICY', baseId: '5' })).toEqual({
      saved: { key: 'label:modelRules', id: 9 },
    });
    expect(harness.putPrompt).toHaveBeenCalledExactlyOnceWith('label:modelRules', 'POLICY', {
      note: undefined,
      baseId: 5,
    });
  });
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

describe('restoreRule', () => {
  it('refuses a restore that would change nothing', async () => {
    service.restoreModelRuleVersion.mockRejectedValue(new RestoreRefusedError('same'));
    expect(await post('restoreRule', { ruleId: '3', versionId: '2' })).toMatchObject({
      status: 400,
    });
  });
});

describe('try', () => {
  it('always judges as Model rules, with only the page grant', async () => {
    harness.scanTexts.mockResolvedValue({ results: [], system: null, rules: null });
    await post('try', { input: 'some model text', judgeAs: 'CommentV2' }, {});
    expect(harness.scanTexts.mock.calls[0][0]).toBe('ModelRules');
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

describe('load', () => {
  it('still lists the rules when the policy prompt cannot load', async () => {
    const rule = { id: 3, subject: 'Example' };
    service.listModelRules.mockResolvedValue([rule]);
    harness.getPrompts.mockRejectedValue(new Error('down'));
    const data = (await load({
      url: new URL('http://x/text-scan/model-rules'),
    } as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
    expect(data).toMatchObject({
      rules: [rule],
      policy: { ok: false, error: 'Could not load the policy prompt: unexpected error' },
      authors: {},
    });
  });
});
