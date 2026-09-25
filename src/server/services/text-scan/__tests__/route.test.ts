import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as SubmitModule from '~/server/services/text-scan/submit';

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof SubmitModule>()),
  scanEntity: vi.fn(),
  scanEntityInBackground: vi.fn(),
}));

const { legacyProfanityAutoNsfwApplies, submitTextModerationOrScan } = await import(
  '~/server/services/text-scan/route'
);
const { getTextScanMode } = await import('~/server/services/text-scan/mode');
const { scanEntity, scanEntityInBackground } = await import('~/server/services/text-scan/submit');

const xguard = vi.fn();
const onActiveSkip = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  xguard.mockResolvedValue({ id: 'xg-1' });
});

describe('submitTextModerationOrScan', () => {
  it('off: XGuard only', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('off');
    expect(await submitTextModerationOrScan({ entityType: 'Article', entityId: 1, xguard })).toEqual({ id: 'xg-1' });
    expect(scanEntity).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('shadow: XGuard keeps acting, and a shadow scan runs beside it', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    expect(await submitTextModerationOrScan({ entityType: 'Article', entityId: 1, xguard })).toEqual({ id: 'xg-1' });
    expect(xguard).toHaveBeenCalledTimes(1);
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Article', entityId: 1, force: undefined });
    expect(scanEntity).not.toHaveBeenCalled();
  });

  it('shadow: the shadow scan still starts when the XGuard submit declines', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    xguard.mockResolvedValue(undefined);
    await submitTextModerationOrScan({ entityType: 'Model', entityId: 2, xguard });
    expect(scanEntityInBackground).toHaveBeenCalled();
  });

  it.each([
    [{ status: 'submitted', workflowId: 'wf-1' }, { id: 'wf-1' }],
    [{ status: 'skipped', reason: 'unchanged' }, null],
    [{ status: 'failed' }, null],
  ] as const)('active: text-scan replaces XGuard (%o)', async (result, expected) => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(scanEntity).mockResolvedValue(result as never);
    expect(await submitTextModerationOrScan({ entityType: 'Article', entityId: 1, xguard })).toEqual(expected);
    expect(xguard).not.toHaveBeenCalled();
  });

  it('active: a skip reaches the caller, a submit or failure does not', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'skipped', reason: 'unchanged' });
    await submitTextModerationOrScan({ entityType: 'Challenge', entityId: 3, xguard, onActiveSkip });
    expect(onActiveSkip).toHaveBeenCalledWith('unchanged');

    onActiveSkip.mockClear();
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'failed' });
    await submitTextModerationOrScan({ entityType: 'Challenge', entityId: 3, xguard, onActiveSkip });
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'submitted', workflowId: 'wf' });
    await submitTextModerationOrScan({ entityType: 'Challenge', entityId: 3, xguard, onActiveSkip });
    expect(onActiveSkip).not.toHaveBeenCalled();
  });

  it('passes force through for moderator rescans', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(scanEntity).mockResolvedValue({ status: 'submitted', workflowId: 'wf-1' });
    await submitTextModerationOrScan({ entityType: 'Challenge', entityId: 3, force: true, xguard });
    expect(scanEntity).toHaveBeenCalledWith({ entityType: 'Challenge', entityId: 3, force: true });
  });
});

describe('legacyProfanityAutoNsfwApplies', () => {
  it.each([
    ['off', true],
    ['shadow', true],
    ['active', false],
  ] as const)('%s → %s', async (mode, applies) => {
    vi.mocked(getTextScanMode).mockResolvedValue(mode);
    expect(await legacyProfanityAutoNsfwApplies('Model', 5)).toBe(applies);
    expect(getTextScanMode).toHaveBeenCalledWith('Model', 5);
  });

  it('evaluates id 0 for a create, which has no id yet', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('off');
    await legacyProfanityAutoNsfwApplies('Bounty', undefined);
    expect(getTextScanMode).toHaveBeenCalledWith('Bounty', 0);
  });
});
