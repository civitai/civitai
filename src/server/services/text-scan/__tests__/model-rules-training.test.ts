import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const logs = loggingMock.logToAxiom;

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

const { trainingMatchesModelRules } = await import(
  '~/server/services/text-scan/model-rules-training'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const subject = (name: string) => ({
  userId: 1,
  declared: {},
  fields: [{ heading: 'Name', text: name }],
});
const RULES = [{ id: 3, subject: 'Example Franchise', description: '', aliases: ['Hero One'] }];
const run = { userId: 1, source: 'trainer' };
const trainer = {
  triggerWord: 'herotw',
  ...run,
  model: { id: 7, versionId: 11, meta: null as Record<string, unknown> | null },
};
const textOnly = { triggerWord: 'Hero One', ...run, source: 'training-studio' };

beforeEach(() => {
  vi.clearAllMocks();
  getTextScanMode.mockResolvedValue('active');
  getEnabledModelRules.mockResolvedValue(RULES);
  loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Hero One LoRA')]]));
});

describe('trainingMatchesModelRules, a run with a draft model', () => {
  it.each(['shadow', 'active'])(
    'records a training hold on the draft in %s mode, for the text a publish will hash',
    async (mode) => {
      getTextScanMode.mockResolvedValue(mode);
      await trainingMatchesModelRules(trainer);

      expect(loadModelScanSubjects).toHaveBeenCalledWith([7], { prePublish: { versionIds: [11] } });
      expect(syncModelRulesHold).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          source: 'training',
          mode,
          applied: false,
          textHash: textScanTextHash(subject('Hero One LoRA')),
          matches: [expect.objectContaining({ ruleId: 3 })],
        })
      );
    }
  );

  it('refuses the run in active mode and lets it through in shadow mode', async () => {
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(true);
    getTextScanMode.mockResolvedValue('shadow');
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(false);
  });

  it('passes a draft whose rule a moderator cleared for this exact text, and holds nothing', async () => {
    const textHash = textScanTextHash(subject('Hero One LoRA'));
    const meta = { modelRulesCleared: { ruleIds: [3], textHash } };
    await expect(
      trainingMatchesModelRules({ ...trainer, model: { ...trainer.model, meta } })
    ).resolves.toBe(false);
    expect(syncModelRulesHold.mock.calls.every(([, held]) => held === null)).toBe(true);
  });

  it('passes a cleared draft whose trigger word matches the same cleared rule', async () => {
    const textHash = textScanTextHash(subject('Hero One LoRA'));
    const meta = { modelRulesCleared: { ruleIds: [3], textHash } };
    await expect(
      trainingMatchesModelRules({
        ...trainer,
        triggerWord: 'Hero One',
        model: { ...trainer.model, meta },
      })
    ).resolves.toBe(false);
  });

  it('closes only a stale training hold when the text matches nothing', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Plain LoRA')]]));
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(false);
    expect(syncModelRulesHold).toHaveBeenCalledWith(7, null, { onlySource: 'training' });
  });

  it('does nothing in off mode', async () => {
    getTextScanMode.mockResolvedValue('off');
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(false);
    expect(getEnabledModelRules).not.toHaveBeenCalled();
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });

  it('fails open, with a warning, when the rules cannot be loaded', async () => {
    getEnabledModelRules.mockRejectedValue(new Error('redis down'));
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(false);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('still refuses in active mode when the hold cannot be written, and warns', async () => {
    syncModelRulesHold.mockRejectedValue(new Error('db down'));
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(true);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('still refuses in active mode when a moderator is mid-decision on the pending hold', async () => {
    const busy = new Error('busy');
    busy.name = 'ModelRulesHoldBusyError';
    syncModelRulesHold.mockRejectedValue(busy);
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(true);
  });

  it('lets a shadow-mode run through when the hold cannot be written', async () => {
    getTextScanMode.mockResolvedValue('shadow');
    syncModelRulesHold.mockRejectedValue(new Error('db down'));
    await expect(trainingMatchesModelRules(trainer)).resolves.toBe(false);
  });

  it('catches a trigger word that is not in the stored text yet', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map([[7, subject('Plain LoRA')]]));
    await expect(trainingMatchesModelRules({ ...trainer, triggerWord: 'Hero One' })).resolves.toBe(
      true
    );
  });

  it('checks the trigger word when the draft has no text to load, logging only in shadow mode', async () => {
    loadModelScanSubjects.mockResolvedValue(new Map());
    await expect(trainingMatchesModelRules({ ...trainer, triggerWord: 'Hero One' })).resolves.toBe(
      true
    );

    getTextScanMode.mockResolvedValue('shadow');
    await expect(trainingMatchesModelRules({ ...trainer, triggerWord: 'Hero One' })).resolves.toBe(
      false
    );
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });
});

describe('trainingMatchesModelRules, a text-only run', () => {
  it('refuses in active mode and records no hold', async () => {
    await expect(trainingMatchesModelRules(textOnly)).resolves.toBe(true);
    expect(syncModelRulesHold).not.toHaveBeenCalled();
    expect(loadModelScanSubjects).not.toHaveBeenCalled();
  });

  it('lets it through in shadow mode and logs the match without the term', async () => {
    getTextScanMode.mockResolvedValue('shadow');
    await expect(trainingMatchesModelRules(textOnly)).resolves.toBe(false);

    const entry = logs.mock.calls
      .map(([e]) => e)
      .find((e) => e.name === 'training-model-rules-match');
    expect(entry).toMatchObject({ userId: 1, source: 'training-studio', ruleIds: [3] });
    expect(JSON.stringify(entry)).not.toContain('Hero One');
    expect(syncModelRulesHold).not.toHaveBeenCalled();
  });

  it('passes a trigger word that matches no rule', async () => {
    await expect(
      trainingMatchesModelRules({ ...textOnly, triggerWord: 'plainword' })
    ).resolves.toBe(false);
  });

  it('does nothing in off mode, and fails open when the rules cannot be loaded', async () => {
    getTextScanMode.mockResolvedValue('off');
    await expect(trainingMatchesModelRules(textOnly)).resolves.toBe(false);
    expect(getEnabledModelRules).not.toHaveBeenCalled();

    getTextScanMode.mockResolvedValue('active');
    getEnabledModelRules.mockRejectedValue(new Error('redis down'));
    await expect(trainingMatchesModelRules(textOnly)).resolves.toBe(false);
  });
});
