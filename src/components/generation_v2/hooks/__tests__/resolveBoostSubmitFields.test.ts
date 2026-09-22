import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Confirm from '~/components/generation_v2/DownloadBoostConfirm';

const confirmDownloadBoost = vi.fn();
vi.mock('~/components/generation_v2/DownloadBoostConfirm', async (importOriginal) => ({
  ...(await importOriginal<typeof Confirm>()),
  confirmDownloadBoost: (...args: unknown[]) => confirmDownloadBoost(...args),
}));

import {
  isBoostable,
  resolveBoostSubmitFields,
} from '~/components/generation_v2/hooks/usePreBoost';

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

describe('isBoostable', () => {
  const preparation = {
    resource: 'urn:air:flux1:checkpoint:civitai:1@2',
    queuePosition: 2,
    lane: 'low',
    etaSeconds: 3_900,
    boostedEtaSeconds: 300,
    resources: [],
  };

  it('offers a boost that would print as faster', () => {
    expect(isBoostable(preparation)).toBe(true);
  });

  it('withholds it with no preparation at all', () => {
    expect(isBoostable(undefined)).toBe(false);
  });

  // Already express — there is no higher lane to sell.
  it('withholds it on a workflow already in the high lane', () => {
    expect(isBoostable({ ...preparation, lane: 'high' })).toBe(false);
  });

  it('withholds it with no boosted ETA', () => {
    expect(isBoostable({ ...preparation, boostedEtaSeconds: null })).toBe(false);
  });

  it('withholds it when the rendered numbers would match', () => {
    expect(isBoostable({ ...preparation, etaSeconds: 1_400, boostedEtaSeconds: 1_360 })).toBe(
      false
    );
  });

  // Both ETAs come from one whatIf, so unlike the queue card there is no staleness to guard against
  // — and swapping these arguments must not read as a reason to offer.
  it('still offers when the boosted figure is the larger of the two', () => {
    expect(isBoostable({ ...preparation, etaSeconds: 300, boostedEtaSeconds: 3_900 })).toBe(true);
  });
});
