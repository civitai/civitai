import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as RouteModule from '~/server/services/text-scan/route';

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof RouteModule>()),
  submitTextModerationOrScan: vi.fn(),
}));
// Hand-listed: the real action pulls model-version.service and nsfwLevels.service at load.
vi.mock('~/server/services/text-scan/actions/model-nsfw', () => ({
  applyModelNsfwTextScan: vi.fn(async () => ({ deferredRatingNotice: null })),
  applySystemModelNsfwFlag: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Hand-listed, as in model-moderation.submit.test.ts.
vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ bustPublicModelResponseCache: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { modelModerationAdapter, submitModelTextModeration, submitModelTextModerationBackfill } =
  await import('~/server/services/model-moderation.adapter');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');
const { submitTextModerationOrScan } = await import('~/server/services/text-scan/route');
const { applyModelNsfwTextScan } = await import('~/server/services/text-scan/actions/model-nsfw');
const { isFlipt } = await import('~/server/flipt/client');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');

beforeEach(() => vi.clearAllMocks());

describe('modelModerationAdapter — text scan', () => {
  it.each([
    ['off', false, false],
    ['off', true, true],
    ['shadow', false, false],
    ['shadow', true, true],
    ['active', false, true],
  ] as const)('isEnabled with mode %s and XGuard flag %s is %s', async (mode, xguard, enabled) => {
    vi.mocked(getTextScanMode).mockResolvedValue(mode);
    vi.mocked(isFlipt).mockResolvedValue(xguard);
    expect(await modelModerationAdapter.isEnabled!({ entityId: 5 })).toBe(enabled);
  });

  it('routes submit; the XGuard path keeps its own flag gate', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    vi.mocked(isFlipt).mockResolvedValue(false);
    expect(await modelModerationAdapter.submit({ entityId: 5, content: 'x' })).toBeUndefined();
    expect(submitTextModeration).not.toHaveBeenCalled();
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Model', entityId: 5 })
    );
  });

  it('applies the nsfw action', async () => {
    const args = {
      entityId: 5,
      workflowId: 'wf',
      outcome: { triggeredLabels: [], nsfwLevel: 8 },
      subject: { fields: [], declared: {} },
    };
    await modelModerationAdapter.applyTextScan!(args as never);
    expect(applyModelNsfwTextScan).toHaveBeenCalledWith(args);
  });
});

describe('submitModelTextModeration — routed', () => {
  it('routes a non-moderator save', async () => {
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf' });
    await submitModelTextModeration({ id: 7, name: 'LoRA', description: null });
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Model', entityId: 7 })
    );
  });

  it('never scans a moderator save, in either pipeline', async () => {
    await submitModelTextModeration({ id: 7, name: 'LoRA', description: null, isModerator: true });
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
  });

  it('swallows a routing failure so the save never fails', async () => {
    vi.mocked(submitTextModerationOrScan).mockRejectedValue(new Error('down'));
    await expect(submitModelTextModeration({ id: 7, name: 'LoRA' })).resolves.toBeUndefined();
  });
});

describe('submitModelTextModerationBackfill — routed', () => {
  it('forces a text scan instead of XGuard once Model is active', async () => {
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf' });
    expect(await submitModelTextModerationBackfill({ id: 7, name: 'LoRA', description: null })).toEqual({
      id: 'wf',
    });
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Model', entityId: 7, force: true })
    );
  });

  it('keeps the forced XGuard rescan as the off/shadow path', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    vi.mocked(submitTextModeration).mockResolvedValue({ id: 'xg' } as never);
    await submitModelTextModerationBackfill({ id: 7, name: 'LoRA' });
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 7, forceRescan: true })
    );
  });

  it('submits nothing for a model with no text', async () => {
    expect(await submitModelTextModerationBackfill({ id: 7, name: '' })).toBeNull();
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
  });
});
