import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  codesCsv,
  linkStatus,
  type GiftBatchRow,
  type GiftLinkRow,
} from './gift-links';

const NOW = new Date('2026-11-07T12:00:00Z');
const link = (over: Partial<GiftLinkRow>): GiftLinkRow => ({
  id: 1,
  codeHint: 'ABCD',
  label: null,
  maxRedemptions: null,
  redemptionCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  ...over,
});
const batch = (over: Partial<GiftBatchRow>): GiftBatchRow => ({
  batchId: 'b',
  label: null,
  total: 3,
  claimed: 0,
  live: 3,
  createdAt: '2026-11-01T00:00:00Z',
  expiresAt: null,
  ...over,
});

describe('gift status', () => {
  it('calls a link at its cap Claimed, so it is not offered for revoke as if claimable', () => {
    expect(linkStatus(link({ maxRedemptions: 2, redemptionCount: 2 }), NOW)).toBe('Claimed');
    expect(linkStatus(link({ maxRedemptions: 2, redemptionCount: 1 }), NOW)).toBe('Active');
    expect(linkStatus(link({ expiresAt: '2026-11-07T11:00:00Z' }), NOW)).toBe('Expired');
    expect(linkStatus(link({ revokedAt: '2026-11-02T00:00:00Z' }), NOW)).toBe('Revoked');
    expect(
      linkStatus(
        link({ revokedAt: '2026-11-02T00:00:00Z', expiresAt: '2026-11-03T00:00:00Z' }),
        NOW
      )
    ).toBe('Revoked');
  });

  it('keeps a batch Active while any code is claimable', () => {
    expect(batchStatus(batch({ claimed: 2, live: 1 }), NOW)).toBe('Active');
    expect(batchStatus(batch({ claimed: 3, live: 0 }), NOW)).toBe('Claimed');
    expect(batchStatus(batch({ claimed: 1, live: 0 }), NOW)).toBe('Revoked');
    expect(
      batchStatus(batch({ claimed: 1, live: 0, expiresAt: '2026-11-06T00:00:00Z' }), NOW)
    ).toBe('Expired');
  });
});

describe('codesCsv', () => {
  it('gives every code its claim link', () => {
    expect(codesCsv(['cvg_A', 'cvg_B'], 'https://civitai.red/gift/')).toBe(
      'code,link\ncvg_A,https://civitai.red/gift/cvg_A\ncvg_B,https://civitai.red/gift/cvg_B\n'
    );
  });
});
