import { describe, expect, it, vi } from 'vitest';
import { isFliptPublic } from '~/server/flipt/tester-segment';
import { isFinalsMalwareScanOn } from '~/server/services/creator-service-deal-file-scan';

vi.mock('~/server/flipt/tester-segment', () => ({ isFliptPublic: vi.fn() }));

describe('isFinalsMalwareScanOn', () => {
  it('reads the finals malware scan flag', async () => {
    vi.mocked(isFliptPublic).mockResolvedValue(true);
    expect(await isFinalsMalwareScanOn()).toBe(true);
    expect(isFliptPublic).toHaveBeenLastCalledWith('creator-services-finals-malware-scan');
    vi.mocked(isFliptPublic).mockResolvedValue(false);
    expect(await isFinalsMalwareScanOn()).toBe(false);
  });

  it('is off when Flipt cannot answer', async () => {
    vi.mocked(isFliptPublic).mockRejectedValue(new Error('flipt down'));
    expect(await isFinalsMalwareScanOn()).toBe(false);
  });
});
