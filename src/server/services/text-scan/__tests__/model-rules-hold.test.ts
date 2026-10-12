import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTextScanMode, getModelRulesForPrompt, loadModelScanSubjects } = vi.hoisted(() => ({
  getTextScanMode: vi.fn(),
  getModelRulesForPrompt: vi.fn(),
  loadModelScanSubjects: vi.fn(),
}));

vi.mock('~/server/services/text-scan/mode', () => ({ getTextScanMode }));
vi.mock('~/server/services/text-scan/model-rules', () => ({ getModelRulesForPrompt }));
vi.mock('~/server/services/text-scan/profiles/model.profile', () => ({ loadModelScanSubjects }));

const { checkModelRulesLiteralHold } = await import('~/server/services/text-scan/model-rules-hold');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const subject = (name: string) => ({
  userId: 1,
  declared: {},
  fields: [{ heading: 'Name', text: name }],
});
const RULES = [{ id: 3, subject: 'Example Franchise', description: '', aliases: ['Hero One'] }];
const base = { modelId: 7, versionIds: [11] };

beforeEach(() => {
  vi.clearAllMocks();
  getTextScanMode.mockResolvedValue('active');
  getModelRulesForPrompt.mockResolvedValue(RULES);
  loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One LoRA')]]));
});

describe('checkModelRulesLiteralHold', () => {
  it('holds a literal hit in active mode, with the hash of the text a rescan will see', async () => {
    await expect(checkModelRulesLiteralHold(base)).resolves.toEqual({
      ruleIds: [3],
      textHash: textScanTextHash(subject('Hero One LoRA')),
    });
    expect(getTextScanMode).toHaveBeenCalledWith('ModelRules', 7);
    expect(loadModelScanSubjects).toHaveBeenCalledWith([7], { prePublish: { versionIds: [11] } });
  });

  it('does nothing in shadow and off modes, and loads no rules', async () => {
    for (const mode of ['shadow', 'off']) {
      getTextScanMode.mockResolvedValue(mode);
      await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
    }
    expect(getModelRulesForPrompt).not.toHaveBeenCalled();
    expect(loadModelScanSubjects).not.toHaveBeenCalled();
  });

  it('passes text that matches no rule', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Plain LoRA')]]));
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
  });

  it('skips rules a moderator cleared for this exact text, and holds again once it changes', async () => {
    const textHash = textScanTextHash(subject('Hero One LoRA'));
    const cleared = { modelRulesCleared: { ruleIds: [3], textHash } };
    await expect(checkModelRulesLiteralHold({ ...base, meta: cleared })).resolves.toBeNull();

    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One LoRA v2')]]));
    await expect(checkModelRulesLiteralHold({ ...base, meta: cleared })).resolves.toMatchObject({
      ruleIds: [3],
    });
  });

  it('reports only the rules left once a moderator cleared some for this text', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One and Other Name')]]));
    getModelRulesForPrompt.mockResolvedValue([
      ...RULES,
      { id: 4, subject: 'Other Name', description: '', aliases: [] },
    ]);
    const textHash = textScanTextHash(subject('Hero One and Other Name'));
    const meta = { modelRulesCleared: { ruleIds: [3], textHash } };
    await expect(checkModelRulesLiteralHold({ ...base, meta })).resolves.toEqual({
      ruleIds: [4],
      textHash,
    });
  });

  it('does nothing when there are no rules', async () => {
    getModelRulesForPrompt.mockResolvedValue([]);
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
    expect(loadModelScanSubjects).not.toHaveBeenCalled();
  });

  it('lets the publish through when the check itself fails', async () => {
    getModelRulesForPrompt.mockRejectedValue(new Error('redis down'));
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
  });

  it('does nothing when the model cannot be loaded', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map());
    await expect(checkModelRulesLiteralHold(base)).resolves.toBeNull();
  });
});
