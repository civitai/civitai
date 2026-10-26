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

const DISPUTED = '2026-10-10T00:00:00Z';

describe('buyerFinalDownloads', () => {
  it('sums the buyer downloads across finals, with the first and last time', () => {
    expect(
      buyerFinalDownloads(
        [
          file(1, 'Final', [
            entry('Buyer', 'Download', 2, '2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z'),
          ]),
          file(2, 'Final', [entry('Buyer', 'Download', 1, '2026-10-03T00:00:00Z')]),
        ],
        DISPUTED
      )
    ).toEqual({
      downloaded: true,
      count: 3,
      firstAt: '2026-10-03T00:00:00Z',
      lastAt: '2026-10-12T00:00:00Z',
      beforeDispute: true,
    });
  });

  it('is never when only the seller, a moderator or a preview was taken', () => {
    expect(
      buyerFinalDownloads(
        [
          file(1, 'Final', [
            entry('Seller', 'Download', 4, '2026-10-01T00:00:00Z'),
            entry('Moderator', 'ModeratorFetch', 2, '2026-10-01T00:00:00Z'),
            entry('Moderator', 'Download', 1, '2026-10-01T00:00:00Z'),
          ]),
          file(2, 'Preview', [entry('Buyer', 'Download', 1, '2026-10-01T00:00:00Z')]),
        ],
        DISPUTED
      )
    ).toEqual({ downloaded: false });
  });

  it('marks a first download after the dispute opened as not before it', () => {
    const result = buyerFinalDownloads(
      [file(1, 'Final', [entry('Buyer', 'Download', 1, '2026-10-11T00:00:00Z')])],
      DISPUTED
    );
    expect(result).toMatchObject({ downloaded: true, beforeDispute: false });
  });

  it('is unknown, not never, when a final carries no access list', () => {
    expect(buyerFinalDownloads([file(1, 'Final')], DISPUTED)).toEqual({ downloaded: null });
  });
});
