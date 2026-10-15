import { describe, expect, it } from 'vitest';
import {
  acceptDeliveryBlocked,
  buyerFinalsState,
  type DealFileFacts,
  filesByRound,
  finalsCopy,
  isPreparingPreviews,
  sellerFileStatus,
  uploadRefusal,
  uploadSlotsLeft,
} from '~/components/CreatorShop/Services/deals/deal-files';

const MB = 1024 * 1024;
let nextId = 1;
const file = (over: Partial<DealFileFacts>): DealFileFacts => ({
  id: nextId++,
  round: 0,
  kind: 'Final',
  status: 'Ready',
  scanStatus: 'Pending',
  canDownload: false,
  ...over,
});

describe('upload checks before sending', () => {
  it('takes only image previews, with the animated allowance for GIF and WebP', () => {
    expect(uploadRefusal('Preview', { name: 'a.mp4', type: 'video/mp4', size: MB })).toMatch(
      /JPEG, PNG, WebP or GIF/
    );
    expect(
      uploadRefusal('Preview', { name: 'a.gif', type: 'image/gif', size: 15 * MB })
    ).toBeNull();
    expect(uploadRefusal('Preview', { name: 'a.png', type: 'image/png', size: 15 * MB })).toMatch(
      /too large \(max 10 MB\)/
    );
    expect(uploadRefusal('Preview', { name: 'a.webp', type: 'image/webp', size: 21 * MB })).toMatch(
      /max 20 MB/
    );
  });

  it('takes finals by extension, refuses video and unknown types, and caps the size', () => {
    expect(uploadRefusal('Final', { name: 'lora.safetensors', type: '', size: MB })).toBeNull();
    expect(
      uploadRefusal('Final', { name: 'Pack.ZIP', type: 'application/zip', size: MB })
    ).toBeNull();
    expect(uploadRefusal('Final', { name: 'clip.mp4', type: 'video/mp4', size: MB })).toMatch(
      /\.mp4 files can't be delivered/
    );
    expect(uploadRefusal('Final', { name: 'README', type: '', size: 10 })).toMatch(/\(none\)/);
    expect(
      uploadRefusal('Final', { name: 'big.zip', type: 'application/zip', size: 2 * 1024 * MB })
    ).toMatch(/too large/);
  });

  it('counts slots per kind in the round in progress only', () => {
    const files = [file({ kind: 'Preview', round: 0 }), file({ kind: 'Preview', round: 1 })];
    expect(uploadSlotsLeft('Preview', 'Image', files, 1)).toBe(0);
    expect(uploadSlotsLeft('Preview', 'SampleOutputs', files, 1)).toBe(11);
    expect(uploadSlotsLeft('Preview', 'None', [], 0)).toBe(0);
    expect(uploadSlotsLeft('Final', 'Image', files, 1)).toBe(10);
  });
});

describe('preview processing', () => {
  it('polls while a preview is being prepared, not for an abandoned upload', () => {
    expect(isPreparingPreviews([file({ kind: 'Preview', status: 'Processing' })])).toBe(true);
    expect(isPreparingPreviews([file({ kind: 'Preview', status: 'Uploading' })])).toBe(false);
    expect(isPreparingPreviews([file({ kind: 'Preview', status: 'Ready' })])).toBe(false);
  });

  it('tells the seller a preview is being prepared and a final is being checked, never cleared early', () => {
    expect(sellerFileStatus(file({ kind: 'Preview', status: 'Processing' })).label).toBe(
      'Preparing preview'
    );
    expect(sellerFileStatus(file({ kind: 'Final', scanStatus: 'Pending' })).label).toBe(
      'Being checked'
    );
    expect(sellerFileStatus(file({ kind: 'Final', scanStatus: 'Passed' })).label).toBe('Cleared');
    expect(sellerFileStatus(file({ kind: 'Final', scanStatus: 'Failed' })).label).toBe(
      'Failed check'
    );
  });

  it('lists rounds newest first', () => {
    const rounds = filesByRound([file({ round: 0 }), file({ round: 1 }), file({ round: 0 })]);
    expect(rounds.map((r) => [r.round, r.files.length])).toEqual([
      [1, 1],
      [0, 2],
    ]);
  });
});

// Decision (Creator Services P3, briony 2026-10-15): while a final's check is still pending, never
// say the files are ready to download, and show Accept delivery disabled with the reason rather
// than hide it. The server refuses completion until every final in the round has passed.
describe('the buyer and the final files', () => {
  it('says "ready to download" only when the server lets every file download', () => {
    expect(
      buyerFinalsState([file({ canDownload: true, scanStatus: 'Passed' })], { owned: true })
    ).toBe('available');
    const pending = buyerFinalsState([file({ scanStatus: 'Pending' })], { owned: true });
    expect(pending).toBe('checkingOwned');
    expect(finalsCopy[pending!]).not.toMatch(/ready to download/i);
    expect(
      buyerFinalsState(
        [file({ canDownload: true, scanStatus: 'Passed' }), file({ scanStatus: 'Pending' })],
        { owned: true }
      )
    ).toBe('checkingOwned');
  });

  it('before accepting: checking while any file is unchecked, sealed once all have passed', () => {
    expect(buyerFinalsState([file({ scanStatus: 'Pending' })], { owned: false })).toBe('checking');
    expect(buyerFinalsState([file({ scanStatus: 'Passed' })], { owned: false })).toBe('sealed');
    expect(buyerFinalsState([file({ scanStatus: 'Failed' })], { owned: false })).toBe('failed');
    expect(buyerFinalsState([], { owned: false })).toBeNull();
    for (const state of ['checking', 'checkingOwned', 'sealed', 'failed'] as const)
      expect(finalsCopy[state]).not.toMatch(/ready to download/i);
  });

  it('disables Accept delivery while a final in the delivered round is unchecked', () => {
    const delivered = { status: 'Delivered' as const, revisionsUsed: 1 };
    expect(acceptDeliveryBlocked(delivered, [file({ round: 1, scanStatus: 'Pending' })])).toMatch(
      /still being checked/
    );
    expect(
      acceptDeliveryBlocked(delivered, [
        file({ round: 1, scanStatus: 'Passed' }),
        // A sent-back round's file does not hold up this one.
        file({ round: 0, scanStatus: 'Pending' }),
      ])
    ).toBeNull();
    expect(
      acceptDeliveryBlocked({ status: 'Completed', revisionsUsed: 1 }, [
        file({ round: 1, scanStatus: 'Pending' }),
      ])
    ).toBeNull();
    // Unknown is not blocked here; the server still refuses completion.
    expect(acceptDeliveryBlocked(delivered, undefined)).toBeNull();
  });
});
