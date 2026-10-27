import { describe, expect, it } from 'vitest';
import type { DealFile, DealFileAccess } from '$lib/server/creator-services-disputes.service';
import { buyerFinalDownloads } from '../downloads';

const file = (id: number, kind: DealFile['kind'], access?: DealFileAccess[]): DealFile => ({
  dealId: 1,
  id,
  round: 0,
  kind,
  fileName: `f${id}`,
  mimeType: 'application/zip',
  size: 1,
  status: 'Ready',
  failReason: null,
  scanStatus: 'Passed',
  previewUrl: null,
  canDownload: true,
  access,
});
const entry = (
  role: DealFileAccess['role'],
  kind: DealFileAccess['kind'],
  count: number,
  firstAt: string,
  lastAt = firstAt
): DealFileAccess => ({ role, kind, count, firstAt, lastAt });

const RECORDING = '2026-10-01T00:00:00Z';
const deal = { completedAt: '2026-10-02T00:00:00Z', disputeOpenedAt: '2026-10-10T00:00:00Z' };

describe('buyerFinalDownloads', () => {
  it('sums the buyer takes across finals, with the first and last time', () => {
    expect(
      buyerFinalDownloads(
        [
          file(1, 'Final', [
            entry('Buyer', 'Download', 2, '2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z'),
          ]),
          file(2, 'Final', [entry('Buyer', 'Download', 1, '2026-10-03T00:00:00Z')]),
        ],
        deal,
        RECORDING
      )
    ).toEqual({
      state: 'yes',
      count: 3,
      firstAt: '2026-10-03T00:00:00Z',
      lastAt: '2026-10-12T00:00:00Z',
      beforeDispute: true,
      partial: false,
    });
  });

  it('does not count a buyer who is a moderator fetching through the dispute tool', () => {
    const result = buyerFinalDownloads(
      [file(1, 'Final', [entry('Buyer', 'ModeratorFetch', 1, '2026-10-03T00:00:00Z')])],
      deal,
      RECORDING
    );
    expect(result).toEqual({ state: 'never' });
  });

  it('is never when only the seller, a moderator or a preview was taken', () => {
    expect(
      buyerFinalDownloads(
        [
          file(1, 'Final', [
            entry('Seller', 'Download', 4, '2026-10-03T00:00:00Z'),
            entry('Moderator', 'ModeratorFetch', 2, '2026-10-03T00:00:00Z'),
            entry('Moderator', 'Download', 1, '2026-10-03T00:00:00Z'),
          ]),
          file(2, 'Preview', [entry('Buyer', 'Download', 1, '2026-10-03T00:00:00Z')]),
        ],
        deal,
        RECORDING
      )
    ).toEqual({ state: 'never' });
  });

  it('is unknown, not never, for a deal completed before recording began', () => {
    const early = { ...deal, completedAt: '2026-09-20T00:00:00Z' };
    expect(buyerFinalDownloads([file(1, 'Final', [])], early, RECORDING)).toEqual({
      state: 'unknown',
      reason: 'before-recording',
    });
    expect(buyerFinalDownloads([file(1, 'Final', [])], deal, null)).toEqual({
      state: 'unknown',
      reason: 'before-recording',
    });
    // Never paid for: the buyer could not have downloaded, so "never" holds.
    expect(
      buyerFinalDownloads([file(1, 'Final', [])], { ...deal, completedAt: null }, null)
    ).toEqual({ state: 'never' });
  });

  it('does not claim a download came after the dispute when earlier ones may be missing', () => {
    const early = { ...deal, completedAt: '2026-09-20T00:00:00Z' };
    const result = buyerFinalDownloads(
      [file(1, 'Final', [entry('Buyer', 'Download', 1, '2026-10-11T00:00:00Z')])],
      early,
      RECORDING
    );
    expect(result).toMatchObject({ state: 'yes', beforeDispute: null, partial: true });
    expect(
      buyerFinalDownloads(
        [file(1, 'Final', [entry('Buyer', 'Download', 1, '2026-10-11T00:00:00Z')])],
        deal,
        RECORDING
      )
    ).toMatchObject({ state: 'yes', beforeDispute: false, partial: false });
  });

  it('is unknown when a final carries no access list, and absent with no finals', () => {
    expect(buyerFinalDownloads([file(1, 'Final')], deal, RECORDING)).toEqual({
      state: 'unknown',
      reason: 'not-reported',
    });
    expect(buyerFinalDownloads([file(1, 'Preview', [])], deal, RECORDING)).toBeNull();
  });
});
