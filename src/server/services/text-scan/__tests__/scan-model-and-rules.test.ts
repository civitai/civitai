import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as ModeModule from '~/server/services/text-scan/mode';

const { checkModelRulesOnEdit } = vi.hoisted(() => ({ checkModelRulesOnEdit: vi.fn() }));

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/server/services/text-scan/actions/model-rules', () => ({ checkModelRulesOnEdit }));

const { scanModelAndRules, textScanContentHash } = await import(
  '~/server/services/text-scan/submit'
);
const { getTextScanMode } = await import('~/server/services/text-scan/mode');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('off');
});

describe('textScanContentHash', () => {
  const base = { user: 'u', promptIds: { base: 1 }, model: 'm', thinking: false };

  it('is unchanged for scans without rules, and moves with the rule set', () => {
    const plain = textScanContentHash(base);
    expect(textScanContentHash({ ...base, rulesFingerprint: undefined })).toBe(plain);
    const a = textScanContentHash({ ...base, rulesFingerprint: 'a' });
    expect(a).not.toBe(plain);
    expect(textScanContentHash({ ...base, rulesFingerprint: 'b' })).not.toBe(a);
  });
});

describe('scanModelAndRules', () => {
  it('queues the Model scan, and the rules check only when asked', async () => {
    scanModelAndRules(9);
    await vi.waitFor(() => expect(checkModelRulesOnEdit).toHaveBeenCalledWith(9));
    expect(getTextScanMode).toHaveBeenCalledWith('Model', 9);
    expect(getTextScanMode).not.toHaveBeenCalledWith('ModelRules', 9);

    checkModelRulesOnEdit.mockClear();
    scanModelAndRules(9, { rules: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(checkModelRulesOnEdit).not.toHaveBeenCalled();
  });

  it('never lets a failing rules check surface', async () => {
    checkModelRulesOnEdit.mockRejectedValue(new Error('db down'));
    scanModelAndRules(9);
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'model rules edit check failed',
          entityId: 9,
          errorName: 'Error',
        })
      )
    );
  });
});
