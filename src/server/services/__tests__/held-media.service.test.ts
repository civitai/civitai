import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Which images the main app's `/api/mod/held-media` serves past the public CDN. The legal-hold read
 * fails closed for deletion, counting an unreadable hold or a missing marker view as held; served
 * that way here it would open every image, so this pins the opposite direction.
 */

const findUnique = dbMock.dbRead.image.findUnique;
const getAccountLegalHold = vi.hoisted(() => vi.fn());

vi.mock('~/server/services/legal-hold.service', () => ({ getAccountLegalHold }));

import { getHeldMedia } from '~/server/services/held-media.service';

const row = (needsReview: string | null) => ({
  url: 'key',
  type: 'image',
  mimeType: null,
  needsReview,
  userId: 9,
});

beforeEach(() => vi.clearAllMocks());

describe('getHeldMedia', () => {
  it('serves an image in the CSAM queue without reading the hold', async () => {
    findUnique.mockResolvedValue(row('csam'));
    expect(await getHeldMedia(1)).toEqual({ url: 'key', type: 'image', mimeType: null });
    expect(getAccountLegalHold).not.toHaveBeenCalled();
  });

  it.each([
    ['a report', { legs: ['report'], markerView: true }],
    ['a reported image', { legs: ['reported-image'], markerView: false }],
    ['a read hold marker', { legs: ['hold-marker'], markerView: true }],
  ])('serves an image whose owner is held by %s', async (_name, hold) => {
    findUnique.mockResolvedValue(row(null));
    getAccountLegalHold.mockResolvedValue(hold);
    expect(await getHeldMedia(1)).not.toBeNull();
    expect(getAccountLegalHold).toHaveBeenCalledWith(9);
  });

  it.each([
    ['no hold', async () => ({ legs: [], markerView: true })],
    // The fail-closed marker leg: the view is missing, so the hold was assumed, not read.
    ['an assumed marker hold', async () => ({ legs: ['hold-marker'], markerView: false })],
    [
      'an unreadable hold',
      async () => {
        throw new Error('db down');
      },
    ],
  ])('refuses an ordinary image with %s', async (_name, hold) => {
    findUnique.mockResolvedValue(row('minor'));
    getAccountLegalHold.mockImplementation(hold);
    expect(await getHeldMedia(1)).toBeNull();
  });

  it('never treats the placeholder owner as held, though its queued image is served', async () => {
    findUnique.mockResolvedValue({ ...row(null), userId: -1 });
    getAccountLegalHold.mockResolvedValue({ legs: ['report'], markerView: true });
    expect(await getHeldMedia(1)).toBeNull();
    findUnique.mockResolvedValue({ ...row('csam'), userId: -1 });
    expect(await getHeldMedia(1)).not.toBeNull();
  });

  it('refuses a missing image', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getHeldMedia(1)).toBeNull();
  });
});
