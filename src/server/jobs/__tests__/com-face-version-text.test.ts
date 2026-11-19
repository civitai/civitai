import { beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = vi.fn<() => Promise<boolean>>();
vi.mock('~/server/services/com-face-version-text-flag', () => ({
  comVersionTextJobsEnabled: () => enabled(),
}));
const processComFaceVersionText = vi.fn(async () => ({ complete: 1 }));
const sweepComFaceVersionText = vi.fn(async () => [1, 2]);
vi.mock('~/server/services/model-com-face-version-text.service', () => ({
  processComFaceVersionText: () => processComFaceVersionText(),
  sweepComFaceVersionText: () => sweepComFaceVersionText(),
}));

const { runComFaceVersionText, runComFaceVersionTextSweep } = await import(
  '~/server/jobs/com-face-version-text'
);

beforeEach(() => vi.clearAllMocks());

describe('com-face-version-text jobs behind their kill switch', () => {
  it('rate nothing, hold nothing and queue nothing while the flag is off', async () => {
    enabled.mockResolvedValue(false);
    await expect(runComFaceVersionText()).resolves.toEqual({ skipped: expect.any(String) });
    await expect(runComFaceVersionTextSweep()).resolves.toEqual({ skipped: expect.any(String) });
    expect(processComFaceVersionText).not.toHaveBeenCalled();
    expect(sweepComFaceVersionText).not.toHaveBeenCalled();
  });

  it('run once the flag is on (control)', async () => {
    enabled.mockResolvedValue(true);
    await expect(runComFaceVersionText()).resolves.toEqual({ complete: 1 });
    await expect(runComFaceVersionTextSweep()).resolves.toEqual({ queued: 2 });
  });
});
