import { describe, expect, it } from 'vitest';
import { prefersHashMatch } from '~/server/services/generation/generation.service';

/**
 * One hash can sit on files owned by several people — in practice because someone
 * re-uploaded another creator's weights. `prefersHashMatch` decides who gets credited,
 * and it has to agree with get_image_resources.sql's
 * `ORDER BY IIF(version_published,0,1), IIF(is_official,0,1), version_date, file_id`, because that
 * function credits the image page while this credits the generator. They disagreed until
 * 2026-09-15: the SQL took the oldest, this took the newest, so the same file credited
 * the original creator in one place and the re-uploader in the other. Nothing compares
 * the two implementations, so the direction is pinned here.
 */

const match = (over: Partial<Parameters<typeof prefersHashMatch>[0]> = {}) => ({
  versionPublished: true,
  isOfficial: false,
  versionDate: new Date('2025-01-01'),
  fileId: 100,
  ...over,
});

describe('prefersHashMatch', () => {
  it('takes any candidate when there is nothing to compare against', () => {
    expect(prefersHashMatch(match(), undefined)).toBe(true);
  });

  it('prefers a published version over an unpublished one, whatever the dates say', () => {
    const published = match({ versionPublished: true, versionDate: new Date('2026-01-01') });
    const unpublished = match({ versionPublished: false, versionDate: new Date('2020-01-01') });
    expect(prefersHashMatch(published, unpublished)).toBe(true);
    expect(prefersHashMatch(unpublished, published)).toBe(false);
  });

  // Official outranks date. The date rule reads a shared hash as "the earliest upload is the
  // original", which is right between two community copies and wrong when one of them is the
  // canonical host: an official model published a day later than a mirror of its own bytes lost
  // the credit, and reclaiming it took hand-written SQL per version.
  it('prefers an official version over an older community one', () => {
    const official = match({ isOfficial: true, versionDate: new Date('2026-09-23') });
    const mirror = match({ isOfficial: false, versionDate: new Date('2026-09-21') });
    expect(prefersHashMatch(official, mirror)).toBe(true);
    expect(prefersHashMatch(mirror, official)).toBe(false);
  });

  // Published still outranks official: an unpublished official version cannot be served, so
  // crediting it would point the image at a page nobody can open.
  it('prefers a published community version over an unpublished official one', () => {
    const community = match({ isOfficial: false, versionPublished: true });
    const draftOfficial = match({ isOfficial: true, versionPublished: false });
    expect(prefersHashMatch(community, draftOfficial)).toBe(true);
    expect(prefersHashMatch(draftOfficial, community)).toBe(false);
  });

  it('falls through to the date when both are official', () => {
    const older = match({ isOfficial: true, versionDate: new Date('2026-06-29') });
    const newer = match({ isOfficial: true, versionDate: new Date('2026-09-23') });
    expect(prefersHashMatch(older, newer)).toBe(true);
    expect(prefersHashMatch(newer, older)).toBe(false);
  });

  it('prefers the OLDEST of two published versions, not the newest', () => {
    // The whole point: the later upload is the re-upload.
    const original = match({ versionDate: new Date('2024-02-06') });
    const reupload = match({ versionDate: new Date('2025-06-22') });
    expect(prefersHashMatch(original, reupload)).toBe(true);
    expect(prefersHashMatch(reupload, original)).toBe(false);
  });

  it('prefers the oldest among unpublished versions too', () => {
    const older = match({ versionPublished: false, versionDate: new Date('2024-01-01') });
    const newer = match({ versionPublished: false, versionDate: new Date('2026-01-01') });
    expect(prefersHashMatch(older, newer)).toBe(true);
    expect(prefersHashMatch(newer, older)).toBe(false);
  });

  it('falls back to the lowest file id when published and date are identical', () => {
    const date = new Date('2025-01-01');
    expect(
      prefersHashMatch(
        match({ fileId: 5, versionDate: date }),
        match({ fileId: 9, versionDate: date })
      )
    ).toBe(true);
    expect(
      prefersHashMatch(
        match({ fileId: 9, versionDate: date }),
        match({ fileId: 5, versionDate: date })
      )
    ).toBe(false);
  });

  it('is a strict preference: an identical candidate does not displace the incumbent', () => {
    // Otherwise the last row the query happens to return wins, and the winner depends
    // on scan order rather than on the rule.
    expect(prefersHashMatch(match(), match())).toBe(false);
  });

  it('reproduces the production duplicates it was written for', () => {
    // Real shared hashes: the earliest published copy is the original creator in each.
    const cases = [
      { original: new Date('2024-02-06'), reupload: new Date('2025-06-22') }, // 1ac0c6cd4e92
      { original: new Date('2025-05-13'), reupload: new Date('2025-06-30') }, // 61d7ee6c08bd
      { original: new Date('2025-02-25'), reupload: new Date('2026-05-21') }, // 70a66c1a0734
      { original: new Date('2026-07-01'), reupload: new Date('2026-08-02') }, // d85cf97b20d8
    ];
    for (const { original, reupload } of cases) {
      expect(
        prefersHashMatch(match({ versionDate: original }), match({ versionDate: reupload })),
        `expected the ${original.toISOString().slice(0, 10)} upload to win`
      ).toBe(true);
    }
  });
});
