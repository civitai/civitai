import { describe, expect, it, vi } from 'vitest';

import {
  APPROVED_ASSET_SNAPSHOT_VERSION,
  type ApprovedAssetSnapshot,
  approvedAssetSnapshotsEqual,
  buildApprovedAssetSnapshot,
  normalizeListingScreenshots,
  parseApprovedAssetSnapshot,
  readRecordedAssetBaseline,
  resolveRepublishReviewReason,
} from '~/server/services/blocks/app-listing-approved-assets';

/**
 * The approved-asset baseline: build it, round-trip it through JSONB, compare it, and —
 * the load-bearing half — REFUSE to compare when there is nothing to compare against.
 *
 * 🔴 Every "unknown ⇒ review" case here exists because the opposite default is invisible.
 * A parser that coerced a malformed payload into `{iconId:null, coverId:null,
 * screenshots:[]}` would compare EQUAL to any listing with no assets and unequal to every
 * other — i.e. it would look like it worked, in both directions, while measuring nothing.
 */

const snap = (over: Partial<ApprovedAssetSnapshot> = {}): ApprovedAssetSnapshot => ({
  v: APPROVED_ASSET_SNAPSHOT_VERSION,
  iconId: null,
  coverId: null,
  screenshots: [],
  ...over,
});

describe('normalizeListingScreenshots', () => {
  it('orders by `order` and keeps imageId + caption, dropping the order value itself', () => {
    expect(
      normalizeListingScreenshots([
        { imageId: 30, order: 2, caption: 'third' },
        { imageId: 10, order: 0, caption: 'first' },
        { imageId: 20, order: 1, caption: null },
      ])
    ).toEqual([
      { imageId: 10, caption: 'first' },
      { imageId: 20, caption: null },
      { imageId: 30, caption: 'third' },
    ]);
  });

  it('🔴 RENUMBERING the same sequence is NOT a change (the order VALUE is not recorded)', () => {
    // 0,1,2 → 10,20,30 with the same relative order. A snapshot that stored the raw
    // `order` column would report a change no viewer can see and force a needless review.
    const a = normalizeListingScreenshots([
      { imageId: 10, order: 0, caption: null },
      { imageId: 20, order: 1, caption: null },
    ]);
    const b = normalizeListingScreenshots([
      { imageId: 10, order: 10, caption: null },
      { imageId: 20, order: 20, caption: null },
    ]);
    expect(a).toEqual(b);
  });

  it('🔴 genuinely SWAPPING two screenshots IS a change', () => {
    const a = normalizeListingScreenshots([
      { imageId: 10, order: 0, caption: null },
      { imageId: 20, order: 1, caption: null },
    ]);
    const b = normalizeListingScreenshots([
      { imageId: 10, order: 1, caption: null },
      { imageId: 20, order: 0, caption: null },
    ]);
    expect(a).not.toEqual(b);
  });

  it('drops rows with no imageId (they display nothing) but keeps every real one', () => {
    // Positive control on the same call: the filter is not simply eating everything.
    expect(
      normalizeListingScreenshots([
        { imageId: null, order: 0, caption: 'orphan' },
        { imageId: 7, order: 1, caption: 'real' },
      ])
    ).toEqual([{ imageId: 7, caption: 'real' }]);
  });

  it('normalises blank captions: null, empty and whitespace-only all compare equal', () => {
    const [a, b, c] = [null, '', '   '].map(
      (caption) => normalizeListingScreenshots([{ imageId: 1, order: 0, caption }])[0]
    );
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.caption).toBeNull();
    // …but a REAL caption survives, so the normalisation is not just erasing the field.
    expect(
      normalizeListingScreenshots([{ imageId: 1, order: 0, caption: '  hello  ' }])[0].caption
    ).toBe('hello');
  });

  it('is deterministic when two rows share an `order` (the sort is total)', () => {
    const rows = [
      { imageId: 22, order: 0, caption: null },
      { imageId: 11, order: 0, caption: null },
    ];
    expect(normalizeListingScreenshots(rows)).toEqual(
      normalizeListingScreenshots([...rows].reverse())
    );
  });
});

describe('buildApprovedAssetSnapshot', () => {
  it('reads the screenshots and takes icon/cover from the ALREADY-LOADED listing row', async () => {
    const findMany = vi.fn(async () => [{ imageId: 5, order: 0, caption: 'shot' }]);
    const snapshot = await buildApprovedAssetSnapshot(
      { appListingScreenshot: { findMany } } as never,
      'apl_1',
      { iconId: 1, coverId: 2 }
    );
    expect(snapshot).toEqual(
      snap({ iconId: 1, coverId: 2, screenshots: [{ imageId: 5, caption: 'shot' }] })
    );
    // Scoped to THIS listing — asserted on the actual argument, not "was it ever called".
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { appListingId: 'apl_1' } });
  });

  it('coerces an undefined icon/cover to null rather than leaking undefined into JSONB', async () => {
    const snapshot = await buildApprovedAssetSnapshot(
      { appListingScreenshot: { findMany: vi.fn(async () => []) } } as never,
      'apl_1',
      { iconId: undefined, coverId: undefined }
    );
    expect(snapshot).toEqual(snap());
  });
});

describe('parseApprovedAssetSnapshot — 🔴 unknown must never round-trip as empty', () => {
  it('parses a well-formed payload', () => {
    const value = { v: 1, iconId: 1, coverId: null, screenshots: [{ imageId: 9, caption: 'x' }] };
    expect(parseApprovedAssetSnapshot(value)).toEqual(
      snap({ iconId: 1, coverId: null, screenshots: [{ imageId: 9, caption: 'x' }] })
    );
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a number', 7],
    ['an array', [{ v: 1 }]],
    ['no version', { iconId: null, coverId: null, screenshots: [] }],
    ['a FUTURE version', { v: 2, iconId: null, coverId: null, screenshots: [] }],
    ['a string version', { v: '1', iconId: null, coverId: null, screenshots: [] }],
    ['a string iconId', { v: 1, iconId: '1', coverId: null, screenshots: [] }],
    ['a float iconId', { v: 1, iconId: 1.5, coverId: null, screenshots: [] }],
    ['an undefined coverId', { v: 1, iconId: null, screenshots: [] }],
    ['screenshots not an array', { v: 1, iconId: null, coverId: null, screenshots: {} }],
    ['a screenshot with no imageId', { v: 1, iconId: null, coverId: null, screenshots: [{}] }],
    // 🔴 THE NEXT TWO ISOLATE THE imageId GUARD. `{}` above does NOT: its `caption` is
    // `undefined`, so the CAPTION guard one line later rejects it first and the imageId
    // guard never executes — a mutant that deletes the imageId check survives that case
    // while the suite stays green (measured: it did). These carry a VALID caption, so
    // nothing else can reject them and only the imageId guard can.
    [
      'a screenshot whose imageId is a string, with a valid caption',
      { v: 1, iconId: null, coverId: null, screenshots: [{ imageId: '9', caption: null }] },
    ],
    [
      'a screenshot whose imageId is a float, with a valid caption',
      { v: 1, iconId: null, coverId: null, screenshots: [{ imageId: 9.5, caption: 'ok' }] },
    ],
    [
      'a screenshot with a bad caption',
      { v: 1, iconId: null, coverId: null, screenshots: [{ imageId: 1, caption: 5 }] },
    ],
    ['a null screenshot entry', { v: 1, iconId: null, coverId: null, screenshots: [null] }],
  ])('returns null (UNKNOWN, not empty) for %s', (_label, value) => {
    expect(parseApprovedAssetSnapshot(value)).toBeNull();
  });
});

describe('readRecordedAssetBaseline — 🔴 absent and unreadable are DIFFERENT answers', () => {
  it('pulls the snapshot out of an event `before` payload', () => {
    expect(
      readRecordedAssetBaseline({
        status: 'approved',
        assets: { v: 1, iconId: 3, coverId: null, screenshots: [] },
      })
    ).toEqual({ kind: 'snapshot', snapshot: snap({ iconId: 3 }) });
  });

  it.each([
    ['a legacy payload with no `assets` key', { status: 'approved' }],
    ['no payload at all', null],
    ['an undefined payload', undefined],
    ['a non-object payload', 'approved'],
    ['an ARRAY payload', [{ v: 1 }]],
  ])('reports ABSENT for %s — nothing was ever recorded', (_label, before) => {
    expect(readRecordedAssetBaseline(before as never)).toEqual({ kind: 'absent' });
  });

  it.each([
    ['an explicit null baseline', null],
    ['a number where a snapshot should be', 7],
    ['a snapshot from an UNKNOWN future version', { v: 2, iconId: 1, coverId: 2, screenshots: [] }],
    ['a snapshot with a malformed screenshot', { v: 1, iconId: 1, coverId: 2, screenshots: [{}] }],
    ['a snapshot missing `screenshots`', { v: 1, iconId: 1, coverId: 2 }],
  ])('reports UNREADABLE for %s — a baseline was written and cannot be read', (_label, assets) => {
    expect(readRecordedAssetBaseline({ status: 'approved', assets } as never)).toEqual({
      kind: 'unreadable',
    });
  });

  it('🔴 the two absences are NOT interchangeable', () => {
    // The whole reason this function returns three things instead of `Snapshot | null`.
    // A caller that collapses them either sweeps the entire pre-feature population into
    // review, or silently disarms the gate the first time a payload goes bad.
    expect(readRecordedAssetBaseline({ status: 'approved' } as never)).not.toEqual(
      readRecordedAssetBaseline({ status: 'approved', assets: null } as never)
    );
  });
});

describe('approvedAssetSnapshotsEqual', () => {
  const base = snap({ iconId: 1, coverId: 2, screenshots: [{ imageId: 3, caption: 'a' }] });

  it('equal for an identical surface', () => {
    expect(approvedAssetSnapshotsEqual(base, snap({ ...base }))).toBe(true);
  });

  it.each([
    ['icon swapped', snap({ ...base, iconId: 99 })],
    ['icon cleared', snap({ ...base, iconId: null })],
    ['cover swapped', snap({ ...base, coverId: 99 })],
    ['a screenshot image swapped', snap({ ...base, screenshots: [{ imageId: 99, caption: 'a' }] })],
    [
      'a screenshot caption swapped',
      snap({ ...base, screenshots: [{ imageId: 3, caption: 'b' }] }),
    ],
    [
      'a screenshot added',
      snap({ ...base, screenshots: [...base.screenshots, { imageId: 4, caption: null }] }),
    ],
    ['every screenshot removed', snap({ ...base, screenshots: [] })],
  ])('NOT equal when %s', (_label, other) => {
    expect(approvedAssetSnapshotsEqual(base, other)).toBe(false);
  });

  it('🔴 does not confuse iconId with coverId (a swap of the two is a change)', () => {
    // The fixture's icon and cover are pairwise DISTINCT, so a mutant comparing iconId
    // twice (or coverId twice) still has to see this.
    expect(approvedAssetSnapshotsEqual(base, snap({ ...base, iconId: 2, coverId: 1 }))).toBe(false);
  });
});

describe('resolveRepublishReviewReason — 🔴 the gate itself', () => {
  const live = snap({ iconId: 1, coverId: 2, screenshots: [{ imageId: 3, caption: null }] });
  const recorded = (snapshot: ReturnType<typeof snap>) => ({ kind: 'snapshot' as const, snapshot });

  it('recorded === live ⇒ null (republish stays IMMEDIATE)', () => {
    expect(resolveRepublishReviewReason(recorded(snap({ ...live })), live)).toBeNull();
  });

  it('recorded !== live ⇒ assets-changed', () => {
    expect(resolveRepublishReviewReason(recorded(snap({ ...live, iconId: 42 })), live)).toBe(
      'assets-changed'
    );
  });

  it('🔴 an UNREADABLE baseline ⇒ review — a broken comparison point is not a pass', () => {
    expect(resolveRepublishReviewReason({ kind: 'unreadable' }, live)).toBe('unreadable-baseline');
  });

  it('🔴 an UNREADABLE baseline reviews even when the listing has NO assets', () => {
    // The case a coercing parser would get wrong: an empty snapshot compares EQUAL to a
    // listing with no assets, so "cannot read it" would silently become "unchanged".
    expect(resolveRepublishReviewReason({ kind: 'unreadable' }, snap())).toBe(
      'unreadable-baseline'
    );
  });

  it('🔴 an ABSENT baseline ⇒ null — republish is IMMEDIATE, exactly as before the gate', () => {
    // Deliberately fail-OPEN, and the ONLY arm that is. Nothing was ever recorded for
    // this listing, so there is no change to show a moderator — routing it to review buys
    // no review, and costs every already-removed listing its way back. Bounded and
    // shrinking: only listings unpublished before the recording shipped land here.
    expect(resolveRepublishReviewReason({ kind: 'absent' }, live)).toBeNull();
  });

  it('🔴 ABSENT and UNREADABLE do not share a verdict', () => {
    expect(resolveRepublishReviewReason({ kind: 'absent' }, live)).not.toBe(
      resolveRepublishReviewReason({ kind: 'unreadable' }, live)
    );
  });
});
