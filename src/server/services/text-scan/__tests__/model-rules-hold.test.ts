import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTextScanMode, getEnabledModelRules, loadModelScanSubjects, syncModelRulesHold } =
  vi.hoisted(() => ({
    getTextScanMode: vi.fn(),
    getEnabledModelRules: vi.fn(),
    loadModelScanSubjects: vi.fn(),
    syncModelRulesHold: vi.fn(),
  }));

vi.mock('~/server/services/text-scan/mode', () => ({ getTextScanMode }));
vi.mock('~/server/services/text-scan/model-rules', () => ({ getEnabledModelRules }));
vi.mock('~/server/services/text-scan/profiles/model.profile', () => ({ loadModelScanSubjects }));
vi.mock('~/server/services/text-scan/actions/model-rules-hold', () => ({ syncModelRulesHold }));

const { checkModelRulesLiteralHold } = await import('~/server/services/text-scan/model-rules-hold');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { composeUserText } = await import('~/server/services/text-scan/segment');

const subject = (name: string) => ({
  userId: 1,
  declared: {},
  fields: [{ heading: 'Name', text: name }],
});
const REFERENCES = [{ url: 'https://example.com/ref', label: 'Official art' }];
const RULES = [
  {
    id: 3,
    subject: 'Example Franchise',
    description: '',
    aliases: ['Hero One'],
    category: 'ip' as const,
    references: REFERENCES,
  },
];
const base = { modelId: 7, versionIds: [11] };

beforeEach(() => {
  vi.clearAllMocks();
  getTextScanMode.mockResolvedValue('active');
  getEnabledModelRules.mockResolvedValue(RULES);
  loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One LoRA')]]));
});

const MATCH = { ruleId: 3, term: 'Hero One', field: 'Name', fieldIndex: 0, start: 0, end: 8 };
const RULE_SNAPSHOT = {
  id: 3,
  subject: 'Example Franchise',
  description: '',
  aliases: ['Hero One'],
  category: 'ip',
  references: REFERENCES,
};

describe('checkModelRulesLiteralHold', () => {
  it('returns a literal hit in active mode, with the hash of the text a rescan will see', async () => {
    const textHash = textScanTextHash(subject('Hero One LoRA'));
    await expect(checkModelRulesLiteralHold(base)).resolves.toEqual({
      ruleIds: [3],
      textHash,
      userId: 1,
      text: composeUserText(subject('Hero One LoRA')),
      reason: 'Example Franchise',
      fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
      matches: [MATCH],
      rules: [RULE_SNAPSHOT],
      mode: 'active',
      applied: false,
      versionIds: [11],
    });
    expect(getTextScanMode).toHaveBeenCalledWith('ModelRules', 7);
    expect(loadModelScanSubjects).toHaveBeenCalledWith([7], { prePublish: { versionIds: [11] } });
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });

  it('records the hit as a hold in shadow mode and lets the publish through', async () => {
    getTextScanMode.mockResolvedValue('shadow');
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();

    expect(syncModelRulesHold).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        mode: 'shadow',
        applied: false,
        matches: [MATCH],
        rules: [RULE_SNAPSHOT],
        textHash: textScanTextHash(subject('Hero One LoRA')),
      })
    );
  });

  it('does nothing in off mode, and loads no rules', async () => {
    getTextScanMode.mockResolvedValue('off');
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
    expect(getEnabledModelRules).not.toHaveBeenCalled();
    expect(loadModelScanSubjects).not.toHaveBeenCalled();
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });

  it.each(['shadow', 'active'])(
    'closes a pending hold when the %s text matches nothing',
    async (mode) => {
      getTextScanMode.mockResolvedValue(mode);
      loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Plain LoRA')]]));
      await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
      expect(syncModelRulesHold).toHaveBeenCalledWith(7, null);
    }
  );

  it('reads only the public text of a live model', async () => {
    getTextScanMode.mockResolvedValue('shadow');
    await checkModelRulesLiteralHold({ modelId: 7, live: true });
    expect(loadModelScanSubjects).toHaveBeenCalledWith([7], { publicOnly: true });
  });

  it('leaves the pending hold alone when the model is not public', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map());
    await expect(checkModelRulesLiteralHold({ modelId: 7, live: true })).resolves.toBeNull();
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });

  it('skips rules a moderator cleared for this exact text, and holds again once it changes', async () => {
    const textHash = textScanTextHash(subject('Hero One LoRA'));
    const cleared = { modelRulesCleared: { ruleIds: [3], textHash } };
    await expect(checkModelRulesLiteralHold({ ...base, meta: cleared })).resolves.toBeNull();
    expect(syncModelRulesHold).toHaveBeenCalledWith(7, null);

    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One LoRA v2')]]));
    await expect(checkModelRulesLiteralHold({ ...base, meta: cleared })).resolves.toMatchObject({
      ruleIds: [3],
    });
  });

  it('reports only the rules left once a moderator cleared some for this text', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One and Other Name')]]));
    getEnabledModelRules.mockResolvedValue([
      ...RULES,
      { id: 4, subject: 'Other Name', description: '', aliases: [] },
    ]);
    const textHash = textScanTextHash(subject('Hero One and Other Name'));
    const meta = { modelRulesCleared: { ruleIds: [3], textHash } };
    const hold = await checkModelRulesLiteralHold({ ...base, meta });
    expect(hold).toMatchObject({ ruleIds: [4], textHash, reason: 'Other Name' });
    expect(hold?.matches.map((m) => m.ruleId)).toEqual([4]);
    expect(hold?.rules.map((r) => r.id)).toEqual([4]);
  });

  it('snapshots a rule cached before category and references existed with no references', async () => {
    getEnabledModelRules.mockResolvedValue([
      { id: 3, subject: 'Example Franchise', description: '', aliases: ['Hero One'] },
    ]);
    const hold = await checkModelRulesLiteralHold(base);
    expect(hold?.rules).toEqual([
      { id: 3, subject: 'Example Franchise', description: '', aliases: ['Hero One'], references: [] },
    ]);
  });

  it('does nothing when there are no rules', async () => {
    getEnabledModelRules.mockResolvedValue([]);
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
    expect(loadModelScanSubjects).not.toHaveBeenCalled();
  });

  it('lets the publish through when the check itself fails', async () => {
    getEnabledModelRules.mockRejectedValue(new Error('redis down'));
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
  });

  it('lets the publish through when recording the hold fails', async () => {
    getTextScanMode.mockResolvedValue('shadow');
    syncModelRulesHold.mockRejectedValue(new Error('db down'));
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
  });

  it('does nothing when the model cannot be loaded', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map());
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
  });
});
