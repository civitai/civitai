import { describe, expect, it } from 'vitest';
import type { CivitaiLinkInstance } from '~/components/CivitaiLink/civitai-link-api';
import { detectPairing } from '~/components/CivitaiLink/pairing-detect';

const inst = (id: number, key: string): CivitaiLinkInstance => ({
  id,
  key,
  name: `app-${id}`,
  activated: true,
  origin: null,
  oauthPaired: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
});

describe('detectPairing', () => {
  it('returns null when the list is unchanged', () => {
    const prev = { ids: [1, 2], keys: { 1: 'aaa', 2: 'bbb' } };
    expect(detectPairing(prev, [inst(1, 'aaa'), inst(2, 'bbb')])).toBeNull();
  });

  it('returns the instance whose id was not in the snapshot', () => {
    const prev = { ids: [1], keys: { 1: 'aaa' } };
    expect(detectPairing(prev, [inst(1, 'aaa'), inst(9, 'ccc')])?.id).toBe(9);
  });

  it('returns a known instance whose key changed', () => {
    const prev = { ids: [1, 2], keys: { 1: 'aaa', 2: 'bbb' } };
    expect(detectPairing(prev, [inst(1, 'aaa'), inst(2, 'rekeyed')])?.id).toBe(2);
  });

  // A brand-new install and a re-key can land in the same poll. Preferring the
  // new id keeps the wizard on the app the user just installed.
  it('prefers a new id over a re-key when both appear at once', () => {
    const prev = { ids: [1], keys: { 1: 'aaa' } };
    expect(detectPairing(prev, [inst(1, 'rekeyed'), inst(9, 'ccc')])?.id).toBe(9);
  });

  // Everything is new against an empty snapshot, which is why the worker seeds it
  // from a fresh GET /api/link before arming the poll instead of trusting the tab.
  it('returns the first instance when the snapshot is empty', () => {
    expect(detectPairing({ ids: [], keys: {} }, [inst(1, 'aaa')])?.id).toBe(1);
  });

  // An id we knew but never held a key for (list loaded, never joined) is not a
  // re-key signal — treating `undefined !== key` as a change fires on the first poll.
  it('does not resolve for a known id whose key was never snapshotted', () => {
    const prev = { ids: [1], keys: {} };
    expect(detectPairing(prev, [inst(1, 'aaa')])).toBeNull();
  });

  it('returns null when an instance disappears', () => {
    const prev = { ids: [1, 2], keys: { 1: 'aaa', 2: 'bbb' } };
    expect(detectPairing(prev, [inst(1, 'aaa')])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(detectPairing({ ids: [1], keys: { 1: 'aaa' } }, [])).toBeNull();
  });
});
