import { describe, expect, it } from 'vitest';
import {
  acceptDeliveryBlocked,
  buyerFinalsState,
  type DealFileFacts,
  filesByRound,
  finalsCopy,
  buyerRoundFinalsState,
  filesPollMs,
  sellerFileStatus,
  sortPicked,
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

  it('sets refused picks aside before counting slots, so a bad pick never takes a good one', () => {
    const picked = [
      { name: 'a.mp4', type: 'video/mp4', size: 1 },
      { name: 'b.zip', type: 'application/zip', size: 1 },
      { name: 'c.zip', type: 'application/zip', size: 1 },
    ];
    const sorted = sortPicked('Final', picked, 1);
    expect(sorted.send.map((f) => f.name)).toEqual(['b.zip']);
    expect(sorted.refused.map((f) => f.name)).toEqual(['a.mp4']);
    expect(sorted.overflow).toBe(1);
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
  it('polls fast while a preview is prepared, slowly only while a delivered final is checked', () => {
    const delivered = { status: 'Delivered' as const, revisionsUsed: 1 };
    const pending = file({ kind: 'Final', round: 1, status: 'Ready', scanStatus: 'Pending' });
    expect(filesPollMs([file({ kind: 'Preview', status: 'Processing' })], delivered)).toBe(10_000);
    expect(filesPollMs([pending], delivered)).toBe(30_000);
    // A pending check changes nothing on the page outside the delivered round.
    expect(filesPollMs([pending], { status: 'Accepted', revisionsUsed: 1 })).toBe(false);
    expect(filesPollMs([pending], { status: 'Completed', revisionsUsed: 1 })).toBe(false);
    expect(filesPollMs([{ ...pending, round: 0 }], delivered)).toBe(false);
    // An abandoned upload never polls.
    expect(filesPollMs([file({ kind: 'Preview', status: 'Uploading' })], delivered)).toBe(false);
    expect(filesPollMs([{ ...pending, status: 'Uploading' }], delivered)).toBe(false);
    expect(filesPollMs([{ ...pending, scanStatus: 'Passed' }], delivered)).toBe(false);
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
// than hide it. The server refuses completion until every final in the round has passed (the
// finals gate on acceptServiceDealDelivery and auto-complete); this is the explanation, not the
// guard.
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
    const blocked = (files?: DealFileFacts[], failed = false) =>
      acceptDeliveryBlocked(delivered, { files, failed });
    expect(blocked([file({ round: 1, scanStatus: 'Pending' })])).toMatch(/still being checked/);
    expect(
      blocked([
        file({ round: 1, scanStatus: 'Passed' }),
        // A sent-back round's file does not hold up this one.
        file({ round: 0, scanStatus: 'Pending' }),
      ])
    ).toBeNull();
    expect(
      acceptDeliveryBlocked(
        { status: 'Completed', revisionsUsed: 1 },
        { files: [file({ round: 1, scanStatus: 'Pending' })], failed: false }
      )
    ).toBeNull();
    // Still loading: not one click from an unchecked delivery.
    expect(blocked(undefined)).toMatch(/Loading/);
    // Unreadable: left to the server rather than locked with no way forward.
    expect(blocked(undefined, true)).toBeNull();
    // A failed refresh keeps the files it last read, and they still block.
    expect(blocked([file({ round: 1, scanStatus: 'Pending' })], true)).toMatch(
      /still being checked/
    );
  });

  it('promises an unlock only on the delivered round of a deal that can still be accepted or is owned', () => {
    const pending = [file({ round: 1, scanStatus: 'Passed' })];
    const at = (
      status: 'Delivered' | 'Completed' | 'Disputed' | 'CancellationRequested' | 'Cancelled',
      completedAt: Date | null = null
    ) => ({ status, revisionsUsed: 1, completedAt });
    expect(buyerRoundFinalsState(at('Delivered'), 1, pending)).toBe('sealed');
    expect(buyerRoundFinalsState(at('Delivered'), 0, pending)).toBeNull();
    for (const status of ['CancellationRequested', 'Cancelled', 'Disputed'] as const)
      expect(buyerRoundFinalsState(at(status), 1, pending)).toBeNull();
    expect(buyerRoundFinalsState(at('Disputed', new Date()), 1, pending)).toBe('checkingOwned');
    expect(buyerRoundFinalsState(at('Completed', new Date()), 1, pending)).toBe('checkingOwned');
  });
});
