import { describe, expect, it, vi } from 'vitest';

import {
  assetScanStatusFromIngestion,
  loadListingAssetScansBatch,
  type ListingAssetScanEntry,
} from '~/server/services/blocks/app-listing-assets.service';
import { computeListingProblems, type ListingAssetScan } from '~/server/services/blocks/listing-problems';

/**
 * The shared `ingestion` → scan-status predicate, the batched page reader that uses it,
 * and the type seam between that reader and the advisory it feeds.
 *
 * 🔴 THE PREDICATE IS A CONSOLIDATION, and this suite is what makes the consolidation
 * safe. It replaced three independently-written copies (`getListingAssets`'s `scanOf`,
 * `getAssetScanStatuses`'s ternary, `assertAssetsScanClean`'s branch) that agreed on the
 * MAPPING but disagreed on what an ABSENT row means — `null`, `pending`, `pending`
 * respectively. The predicate now answers only the mapping and returns `null` for absent,
 * with each call site stating its own absence rule in a visible `??`. Both halves are
 * pinned below: the mapping here, the absence rules at their own suites.
 */

describe('assetScanStatusFromIngestion — the one mapping', () => {
  it('Scanned ⇒ scanned', () => {
    expect(assetScanStatusFromIngestion('Scanned')).toBe('scanned');
  });

  it('Blocked ⇒ blocked', () => {
    expect(assetScanStatusFromIngestion('Blocked')).toBe('blocked');
  });

  /**
   * 🔴 EVERY OTHER TERMINAL AND NON-TERMINAL STATE IS `pending`, and the list is
   * enumerated rather than sampled. `Error` and `NotFound` are the interesting members:
   * they are terminal FAILURES, not "still working", and it would be reasonable to argue
   * they should be their own code — but the go-live gate (`assertAssetsScanClean`) has
   * always treated them as not-yet-clean, so reporting them as `scanning-media` keeps the
   * advisory and the gate saying the same thing. A test that only tried `Pending` could
   * not see a mutant that special-cased one of the other four.
   */
  it.each(['Pending', 'Error', 'NotFound', 'PendingManualAssignment', 'Rescan', 'Something-New'])(
    '%s ⇒ pending',
    (ingestion) => {
      expect(assetScanStatusFromIngestion(ingestion)).toBe('pending');
    }
  );

  /**
   * 🔴 ABSENCE IS `null`, NOT A STATUS. This is the whole contract change the
   * consolidation introduced: the predicate refuses to guess, so no call site can inherit
   * another site's answer by accident.
   */
  it('🔴 null / undefined ⇒ null — absence is the caller\'s question', () => {
    expect(assetScanStatusFromIngestion(null)).toBeNull();
    expect(assetScanStatusFromIngestion(undefined)).toBeNull();
  });
});

/** A two-model reader whose calls are recorded, so query COUNT is assertable. */
function reader(
  shots: { appListingId: string; imageId: number | null }[],
  images: { id: number; ingestion: string | null }[]
) {
  const screenshotFindMany = vi.fn(async (args: { where: { appListingId: { in: string[] } } }) =>
    shots.filter((s) => args.where.appListingId.in.includes(s.appListingId) && s.imageId != null)
  );
  const imageFindMany = vi.fn(async (args: { where: { id: { in: number[] } } }) =>
    images.filter((i) => args.where.id.in.includes(i.id))
  );
  return {
    db: {
      appListingScreenshot: { findMany: screenshotFindMany },
      image: { findMany: imageFindMany },
    } as never,
    screenshotFindMany,
    imageFindMany,
  };
}

describe('loadListingAssetScansBatch', () => {
  it('tags each asset with the SLOT it occupies', async () => {
    const { db } = reader(
      [{ appListingId: 'a', imageId: 30 }],
      [
        { id: 10, ingestion: 'Blocked' },
        { id: 20, ingestion: 'Pending' },
        { id: 30, ingestion: 'Scanned' },
      ]
    );
    const out = await loadListingAssetScansBatch([{ id: 'a', iconId: 10, coverId: 20 }], db);
    expect(out.get('a')).toEqual([
      { kind: 'icon', status: 'blocked' },
      { kind: 'cover', status: 'pending' },
      { kind: 'screenshot', status: 'scanned' },
    ]);
  });

  /**
   * 🔴 ICON AND COVER ARE READ FROM THEIR OWN FIELDS. The two ids are distinct AND their
   * ingestion states are distinct, so an implementation that fed `iconId` into the cover
   * slot produces a visibly different answer rather than a symmetric one.
   */
  it('🔴 an icon/cover operand swap changes the ANSWER', async () => {
    const { db } = reader(
      [],
      [
        { id: 10, ingestion: 'Blocked' },
        { id: 20, ingestion: 'Scanned' },
      ]
    );
    const out = await loadListingAssetScansBatch([{ id: 'a', iconId: 10, coverId: 20 }], db);
    expect(out.get('a')).toEqual([
      { kind: 'icon', status: 'blocked' },
      { kind: 'cover', status: 'scanned' },
    ]);
  });

  it('a null icon/cover contributes no entry — presence is the completeness gate\'s job', async () => {
    const { db } = reader([], [{ id: 20, ingestion: 'Scanned' }]);
    const out = await loadListingAssetScansBatch([{ id: 'a', iconId: null, coverId: 20 }], db);
    expect(out.get('a')).toEqual([{ kind: 'cover', status: 'scanned' }]);
  });

  it('an asset whose Image row is missing contributes no entry', async () => {
    const { db } = reader([], []);
    const out = await loadListingAssetScansBatch([{ id: 'a', iconId: 10, coverId: 20 }], db);
    expect(out.get('a')).toEqual([]);
  });

  /**
   * 🔴 EVERY SUBJECT GETS A KEY, even one with nothing attached. A caller reading
   * `map.get(id) ?? []` cannot tell "clean" from "never looked at" if the key is absent —
   * and both this and the fan-out guard depend on the map being total over `subjects`.
   */
  it('🔴 every subject gets a key, so "clean" is distinguishable from "not looked at"', async () => {
    const { db } = reader([], []);
    const out = await loadListingAssetScansBatch(
      [
        { id: 'a', iconId: null, coverId: null },
        { id: 'b', iconId: null, coverId: null },
      ],
      db
    );
    expect([...out.keys()].sort()).toEqual(['a', 'b']);
    expect(out.get('a')).toEqual([]);
  });

  /** 🔴 N listings ⇒ 2 queries, not 2N. The anti-fan-out property, at the unit level. */
  it('🔴 four listings ⇒ exactly one screenshot query and one image query', async () => {
    const subjects = [
      { id: 'a', iconId: 1, coverId: 2 },
      { id: 'b', iconId: 3, coverId: 4 },
      { id: 'c', iconId: 5, coverId: 6 },
      { id: 'd', iconId: 7, coverId: 8 },
    ];
    const { db, screenshotFindMany, imageFindMany } = reader(
      subjects.map((s) => ({ appListingId: s.id, imageId: 100 + s.iconId })),
      [...Array(9).keys()].map((id) => ({ id, ingestion: 'Scanned' }))
    );
    await loadListingAssetScansBatch(subjects, db);
    expect(screenshotFindMany).toHaveBeenCalledTimes(1);
    expect(imageFindMany).toHaveBeenCalledTimes(1);
  });

  /** A repeated image id across listings is queried ONCE (the id set is deduped). */
  it('deduplicates image ids across listings', async () => {
    const { db, imageFindMany } = reader([], [{ id: 10, ingestion: 'Blocked' }]);
    const out = await loadListingAssetScansBatch(
      [
        { id: 'a', iconId: 10, coverId: 10 },
        { id: 'b', iconId: 10, coverId: null },
      ],
      db
    );
    expect(imageFindMany.mock.calls[0][0].where.id.in).toEqual([10]);
    // …and the shared id still produces an entry per SLOT it occupies.
    expect(out.get('a')).toEqual([
      { kind: 'icon', status: 'blocked' },
      { kind: 'cover', status: 'blocked' },
    ]);
    expect(out.get('b')).toEqual([{ kind: 'icon', status: 'blocked' }]);
  });

  /**
   * A screenshot row for a listing outside the page is dropped BEFORE the image query.
   *
   * 🔴 THE ASSERTION IS ON THE QUERY, not only on the output. Dropping the membership
   * guard would leave the OUTPUT unchanged — the grouping ends in `map.get(id)?.push(…)`,
   * which is a silent no-op for an unknown key — so an output-only test cannot see the
   * mutant at all. What the guard actually buys is a bounded `IN (…)` list: without it a
   * stray row widens the image query by an id nobody on this page will read.
   */
  it('🔴 a screenshot row outside the subject set never reaches the image query', async () => {
    const shots = [{ appListingId: 'stranger', imageId: 99 }];
    // Deliberately IGNORES the `where` — the point is that a row the DB should not have
    // returned is still dropped in memory before it can widen the image query.
    const screenshotFindMany = vi.fn(async (_args: { where: unknown }) => shots);
    const imageFindMany = vi.fn(async (_args: { where: { id: { in: number[] } } }) => [
      { id: 99, ingestion: 'Blocked' },
    ]);
    const db = {
      appListingScreenshot: { findMany: screenshotFindMany },
      image: { findMany: imageFindMany },
    } as never;
    const out = await loadListingAssetScansBatch([{ id: 'a', iconId: 10, coverId: null }], db);
    expect(out.get('a')).toEqual([]);
    expect(out.has('stranger')).toBe(false);
    // Only the page's own icon id — 99 belongs to a listing we were not asked about.
    expect(imageFindMany.mock.calls[0][0].where.id.in).toEqual([10]);
  });

  it('an empty subject set issues no queries at all', async () => {
    const { db, screenshotFindMany, imageFindMany } = reader([], []);
    expect((await loadListingAssetScansBatch([], db)).size).toBe(0);
    expect(screenshotFindMany).not.toHaveBeenCalled();
    expect(imageFindMany).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ *
 * 🔴 THE TYPE SEAM
 * ------------------------------------------------------------------------ */

/**
 * 🔴 `ListingAssetScanEntry` (assets service) and `ListingAssetScan` (listing-problems)
 * are two declarations of one shape, kept separate ONLY to avoid closing an import cycle
 * — `listing-problems` already imports `checkListingAssetsComplete` from the assets
 * service, so the assets service must not import back.
 *
 * A structural match is exactly the kind of agreement that decays silently: widen
 * `ListingAssetKind` on one side and the compiler says nothing until the batch's output
 * stops being accepted at a call site nobody is looking at. These two assignments fail the
 * TYPECHECK in both directions if the shapes drift — a guard on the RELATIONSHIP, not on
 * either component.
 *
 * 🔴 They are exercised at RUNTIME too (fed through `computeListingProblems` below),
 * because `tsconfig.json` excludes `src/**\/__tests__/**` — a purely compile-time
 * assertion in this directory is checked only by the deliberate test-typecheck pass, so it
 * must not be the only thing standing here.
 */
const entryToScan: ListingAssetScan = { kind: 'icon', status: 'blocked' } as ListingAssetScanEntry;
const scanToEntry: ListingAssetScanEntry = { kind: 'cover', status: 'pending' } as ListingAssetScan;

describe('🔴 the batch output is what computeListingProblems consumes', () => {
  it('both type directions round-trip through the advisory', () => {
    const { problems } = computeListingProblems({
      iconId: 7,
      coverId: 9,
      screenshotCount: 1,
      description: 'd',
      tagline: 't',
      category: 'utility',
      assetScans: [entryToScan, scanToEntry],
    });
    expect(problems.map((p) => p.code)).toEqual(['blocked-media', 'scanning-media']);
  });

  /**
   * The real end-to-end shape: the batch's OWN output handed straight to the advisory,
   * with no adapter in between. If an adapter ever becomes necessary, this is the test
   * that will say so.
   */
  it('🔴 the batch\'s output feeds the advisory with no adapter', async () => {
    const { db } = reader(
      [{ appListingId: 'a', imageId: 30 }],
      [
        { id: 10, ingestion: 'Blocked' },
        { id: 20, ingestion: 'Scanned' },
        { id: 30, ingestion: 'Pending' },
      ]
    );
    const byListing = await loadListingAssetScansBatch([{ id: 'a', iconId: 10, coverId: 20 }], db);
    const { problems } = computeListingProblems({
      iconId: 10,
      coverId: 20,
      screenshotCount: 1,
      description: 'd',
      tagline: 't',
      category: 'utility',
      assetScans: byListing.get('a') ?? [],
    });
    expect(problems.map((p) => p.code)).toEqual(['blocked-media', 'scanning-media']);
    expect(problems.find((p) => p.code === 'blocked-media')?.severity).toBe('blocking');
  });
});
