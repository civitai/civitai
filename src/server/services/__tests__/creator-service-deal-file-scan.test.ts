import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureFliptInitialized,
  getFliptClientSync,
  getFliptLocalOverride,
} from '~/server/flipt/client';
import { isFinalsMalwareScanOn } from '~/server/services/creator-service-deal-file-scan';

vi.mock('~/server/flipt/client', () => ({
  ensureFliptInitialized: vi.fn(),
  getFliptClientSync: vi.fn(),
  getFliptLocalOverride: vi.fn(),
}));

const evaluateBoolean = vi.fn();

describe('isFinalsMalwareScanOn', () => {
  beforeEach(() => {
    vi.mocked(ensureFliptInitialized).mockReset().mockResolvedValue(undefined);
    vi.mocked(getFliptClientSync)
      .mockReset()
      .mockReturnValue({ evaluateBoolean } as never);
    evaluateBoolean.mockReset();
    vi.mocked(getFliptLocalOverride).mockReset().mockReturnValue(undefined);
  });

  it('follows the finals malware scan flag', async () => {
    evaluateBoolean.mockReturnValue({ enabled: true });
    expect(await isFinalsMalwareScanOn()).toBe(true);
    expect(evaluateBoolean).toHaveBeenLastCalledWith(
      expect.objectContaining({ flagKey: 'creator-services-finals-malware-scan' })
    );
    evaluateBoolean.mockReturnValue({ enabled: false });
    expect(await isFinalsMalwareScanOn()).toBe(false);
  });

  it('is off while the flag has not been created', async () => {
    evaluateBoolean.mockImplementation(() => {
      throw new Error('flag not found');
    });
    expect(await isFinalsMalwareScanOn()).toBe(false);
  });

  it('follows a local override over Flipt, either way', async () => {
    evaluateBoolean.mockImplementation(() => {
      throw new Error('flag not found');
    });
    vi.mocked(getFliptLocalOverride).mockReturnValue('on');
    expect(await isFinalsMalwareScanOn()).toBe(true);
    expect(getFliptLocalOverride).toHaveBeenLastCalledWith('creator-services-finals-malware-scan');
    evaluateBoolean.mockReturnValue({ enabled: true });
    vi.mocked(getFliptLocalOverride).mockReturnValue('off');
    expect(await isFinalsMalwareScanOn()).toBe(false);
  });

  it('stays on when Flipt cannot be reached', async () => {
    vi.mocked(getFliptClientSync).mockReturnValue(null);
    expect(await isFinalsMalwareScanOn()).toBe(true);
    vi.mocked(ensureFliptInitialized).mockRejectedValue(new Error('flipt down'));
    expect(await isFinalsMalwareScanOn()).toBe(true);
    expect(evaluateBoolean).not.toHaveBeenCalled();
  });
});
