import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Confirm from '~/components/generation_v2/DownloadBoostConfirm';

const confirmDownloadBoost = vi.fn();
vi.mock('~/components/generation_v2/DownloadBoostConfirm', async (importOriginal) => ({
  ...(await importOriginal<typeof Confirm>()),
  confirmDownloadBoost: (...args: unknown[]) => confirmDownloadBoost(...args),
}));

import { resolveBoostSubmitFields } from '~/components/generation_v2/hooks/usePreBoost';

const download = {
  preparation: {
    resource: 'urn:air:sdxl:checkpoint:civitai:1@2',
    queuePosition: 2,
    lane: 'low',
    resources: [],
  },
  boostable: true,
  boostFee: 240,
};

beforeEach(() => vi.clearAllMocks());

describe('resolveBoostSubmitFields', () => {
  it('sends the boost the desktop switch already priced, without asking again', async () => {
    await expect(
      resolveBoostSubmitFields({ preBoost: true, download, askFirst: true })
    ).resolves.toEqual({ downloadPriority: 'high' });
    expect(confirmDownloadBoost).not.toHaveBeenCalled();
  });

  it('never asks on desktop — the footer alert is the offer there', async () => {
    await expect(
      resolveBoostSubmitFields({ preBoost: false, download, askFirst: false })
    ).resolves.toEqual({});
    expect(confirmDownloadBoost).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing to boost', { ...download, boostable: false }],
    ['no price to show', { ...download, boostFee: null }],
    ['no downloads at all', undefined],
  ])('does not ask when there is %s', async (_case, value) => {
    await expect(
      resolveBoostSubmitFields({ preBoost: false, download: value, askFirst: true })
    ).resolves.toEqual({});
    expect(confirmDownloadBoost).not.toHaveBeenCalled();
  });

  it('charges when the user chooses Boost', async () => {
    confirmDownloadBoost.mockResolvedValue('boost');
    await expect(
      resolveBoostSubmitFields({ preBoost: false, download, askFirst: true })
    ).resolves.toEqual({ downloadPriority: 'high' });
  });

  it('charges nothing when the user chooses to continue', async () => {
    confirmDownloadBoost.mockResolvedValue('continue');
    await expect(
      resolveBoostSubmitFields({ preBoost: false, download, askFirst: true })
    ).resolves.toEqual({});
  });

  // Null is the submit's "stop" signal. Returning `{}` here spends nothing but sends a generation
  // the user never confirmed; `{ downloadPriority }` would charge them for a dialog they dismissed.
  it('abandons the submit when the dialog is dismissed', async () => {
    confirmDownloadBoost.mockResolvedValue(null);
    await expect(
      resolveBoostSubmitFields({ preBoost: false, download, askFirst: true })
    ).resolves.toBeNull();
  });
});
