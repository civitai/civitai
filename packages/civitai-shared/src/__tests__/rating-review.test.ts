import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '../browsing-levels';
import {
  buildRatingReviewNotification,
  isRatingReviewEntityType,
  ratingReviewEntityLabels,
  collectionRatingLevel,
  modelRatingLevel,
  ratingReviewEntityPath,
  ratingReviewLevelLabel,
  ratingReviewLevels,
  ratingReviewModeratorLevels,
  ratingReviewOwnerLevels,
  effectiveScanFailureClass,
  songNeverReviewable,
  songScanStateOf,
  textScanNsfwReason,
  textScanResultTextHash,
} from '../rating-review';

describe('rating-review constants', () => {
  it('recognises the entity types case-sensitively', () => {
    expect(isRatingReviewEntityType('BountyEntry')).toBe(true);
    expect(isRatingReviewEntityType('bountyEntry')).toBe(false);
    expect(isRatingReviewEntityType('Image')).toBe(false);
  });

  it('Crucible and Collection are disputable; Collection is binary', () => {
    expect(isRatingReviewEntityType('Crucible')).toBe(true);
    expect(isRatingReviewEntityType('Collection')).toBe(true);
    expect(ratingReviewLevels('Collection')).toEqual([NsfwLevel.PG, NsfwLevel.R]);
    expect(ratingReviewLevels('Crucible')).toEqual([1, 2, 4, 8, 16]);
    expect(ratingReviewEntityLabels.Crucible).toBe('Crucible');
  });

  it('lets a crucible be disputed and resolved only downward', () => {
    expect(ratingReviewOwnerLevels('Crucible', NsfwLevel.R)).toEqual([1, 2]);
    expect(ratingReviewModeratorLevels('Crucible', NsfwLevel.R)).toEqual([1, 2, 4]);
    expect(ratingReviewOwnerLevels('Collection', NsfwLevel.PG)).toEqual([1, 4]);
  });

  it('labels a collection SFW/NSFW, like a model', () => {
    expect(ratingReviewLevelLabel('Collection', NsfwLevel.R)).toBe('NSFW');
    expect(ratingReviewLevelLabel('Collection', NsfwLevel.PG)).toBe('SFW');
  });

  it('gives Model a binary SFW/NSFW choice and everyone else the five browsing levels', () => {
    expect(ratingReviewLevels('Model')).toEqual([NsfwLevel.PG, NsfwLevel.R]);
    expect(ratingReviewLevels('Post')).toEqual([1, 2, 4, 8, 16]);
    expect(modelRatingLevel(true)).toBe(NsfwLevel.R);
    expect(modelRatingLevel(false)).toBe(NsfwLevel.PG);
    expect(collectionRatingLevel(NsfwLevel.PG | NsfwLevel.PG13)).toBe(NsfwLevel.PG);
    expect(collectionRatingLevel(NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX)).toBe(NsfwLevel.R);
    expect(collectionRatingLevel(NsfwLevel.XXX)).toBe(NsfwLevel.R);
    expect(collectionRatingLevel(0)).toBe(NsfwLevel.PG);
    expect(ratingReviewLevelLabel('Model', NsfwLevel.R)).toBe('NSFW');
    expect(ratingReviewLevelLabel('Model', NsfwLevel.PG)).toBe('SFW');
    expect(ratingReviewLevelLabel('Post', NsfwLevel.PG13)).toBe('PG-13');
  });

  it('lets a challenge be disputed and resolved only downward', () => {
    expect(ratingReviewOwnerLevels('Challenge', NsfwLevel.R)).toEqual([1, 2]);
    expect(ratingReviewModeratorLevels('Challenge', NsfwLevel.R)).toEqual([1, 2, 4]);
    expect(ratingReviewOwnerLevels('Article', NsfwLevel.R)).toEqual([1, 2, 4, 8, 16]);
    expect(ratingReviewModeratorLevels('Article', NsfwLevel.R)).toEqual([1, 2, 4, 8, 16]);
  });

  it('rates a song like a post, offers its owner every level, and links its own page', () => {
    expect(isRatingReviewEntityType('Song')).toBe(true);
    expect(ratingReviewEntityLabels.Song).toBe('Song');
    expect(ratingReviewLevels('Song')).toEqual([1, 2, 4, 8, 16]);
    expect(ratingReviewOwnerLevels('Song', NsfwLevel.R)).toEqual([1, 2, 4, 8, 16]);
    expect(ratingReviewModeratorLevels('Song', NsfwLevel.R)).toEqual([1, 2, 4, 8, 16]);
    expect(ratingReviewLevelLabel('Song', NsfwLevel.R)).toBe('R');
    expect(ratingReviewEntityPath('Song', 3)).toBe('/images/3');
  });

  it('builds each entity path, and none for an entry without its bounty', () => {
    expect(ratingReviewEntityPath('Article', 3)).toBe('/articles/3');
    expect(ratingReviewEntityPath('Model', 3)).toBe('/models/3');
    expect(ratingReviewEntityPath('Post', 3)).toBe('/posts/3');
    expect(ratingReviewEntityPath('Bounty', 3)).toBe('/bounties/3');
    expect(ratingReviewEntityPath('BountyEntry', 3, 9)).toBe('/bounties/9/entries/3');
    expect(ratingReviewEntityPath('BountyEntry', 3)).toBeNull();
    expect(ratingReviewEntityPath('Challenge', 3)).toBe('/challenges/3');
  });

  it('reads the nsfw reason only from a text-scan result, which is the one that carries a version', () => {
    expect(
      textScanNsfwReason({ version: 1, labels: { nsfw: { level: 'r', reason: 'fake reason' } } })
    ).toBe('fake reason');
    expect(
      textScanNsfwReason({ version: 1, labels: { nsfw: { level: 'r', reason: '  ' } } })
    ).toBeNull();
    expect(textScanNsfwReason({ labels: [{ label: 'nsfw', score: 0.9 }] })).toBeNull();
    expect(
      textScanNsfwReason({ labels: { nsfw: { level: 'r', reason: 'fake reason' } } })
    ).toBeNull();
    expect(textScanNsfwReason(null)).toBeNull();
  });

  it('reads the scanned text hash only from a text-scan result', () => {
    expect(textScanResultTextHash({ version: 1, textHash: 'h1', labels: {} })).toBe('h1');
    expect(textScanResultTextHash({ version: 1, labels: {} })).toBeNull();
    expect(textScanResultTextHash({ textHash: 'h1', labels: [] })).toBeNull();
    expect(textScanResultTextHash(null)).toBeNull();
  });

  it('keys the notification by type and review id and renders levels per entity', () => {
    const n = buildRatingReviewNotification({
      reviewId: 12,
      approved: false,
      entityType: 'Model',
      entityId: 5,
      title: 'My LoRA',
      previousLevel: NsfwLevel.R,
      appliedLevel: NsfwLevel.R,
      modComment: 'text is explicit',
    });
    expect(n).toEqual({
      type: 'rating-review-rejected',
      key: 'rating-review-rejected:12',
      details: {
        entityType: 'Model',
        entityId: 5,
        title: 'My LoRA',
        url: '/models/5',
        previousLevel: 'NSFW',
        appliedLevel: 'NSFW',
        modComment: 'text is explicit',
      },
    });
  });
});

describe('songNeverReviewable', () => {
  const state = (
    ingestion: string,
    retryCount: number | null = null,
    failureClass: string | null = null,
    failureReason: string | null = null
  ) => songNeverReviewable({ ingestion, retryCount, failureClass, failureReason });

  it('is true for a removed song, a lost file, and a scan past its retry ceiling', () => {
    expect(state('Blocked')).toBe(true);
    expect(state('NotFound')).toBe(true);
    expect(state('Error', 9)).toBe(true);
    expect(state('Error', 1, 'permanent')).toBe(true);
    expect(state('Error', 30, 'transient')).toBe(true);
    expect(state('Rescan', 9)).toBe(true);
  });

  it('is false for a reviewed song and one whose scans are running or due a retry', () => {
    expect(state('Scanned')).toBe(false);
    expect(state('Pending')).toBe(false);
    expect(state('Error', 8)).toBe(false);
    expect(state('Error', 29, 'transient')).toBe(false);
    expect(state('Rescan', 8)).toBe(false);
  });
});

describe('songScanStateOf', () => {
  it("reads the current error's class and reason over the last failure's", () => {
    expect(
      songScanStateOf('Error', {
        retryCount: 3,
        error: { failureClass: 'transient', reason: 'timeout' },
        lastFailure: { failureClass: 'permanent', reason: 'unsupported' },
      })
    ).toEqual({
      ingestion: 'Error',
      retryCount: 3,
      failureClass: 'transient',
      failureReason: 'timeout',
    });
  });

  it("falls back to the last failure's once the error is cleared for a resubmission", () => {
    expect(
      songScanStateOf('Pending', {
        retryCount: 1,
        lastFailure: { failureClass: 'permanent', reason: 'unsupported' },
      })
    ).toEqual({
      ingestion: 'Pending',
      retryCount: 1,
      failureClass: 'permanent',
      failureReason: 'unsupported',
    });
  });

  it('reads nothing from missing or malformed scan jobs', () => {
    const none = { retryCount: null, failureClass: null, failureReason: null };
    expect(songScanStateOf('Scanned', null)).toEqual({ ingestion: 'Scanned', ...none });
    expect(songScanStateOf('Error', { retryCount: '3', error: { failureClass: 7 } })).toEqual({
      ingestion: 'Error',
      ...none,
    });
  });
});

describe('the effective scan failure class, as the ingest cron reads it', () => {
  it('re-reads an unknown or missing class from the failure reason, and keeps a known one', () => {
    expect(effectiveScanFailureClass('unknown', 'Failed to create container')).toBe('transient');
    expect(effectiveScanFailureClass(null, 'could not decode the file')).toBe('permanent');
    expect(effectiveScanFailureClass('permanent', 'gateway timeout')).toBe('permanent');
    expect(effectiveScanFailureClass('unknown', 'something odd')).toBe('unknown');
    expect(effectiveScanFailureClass(null, null)).toBeNull();
  });

  it("decides a song's dispute by the class the cron retries it under", () => {
    // Stored unknown, but the reason reads transient: the cron retries it up to 30 times.
    expect(
      songNeverReviewable({
        ingestion: 'Error',
        retryCount: 12,
        failureClass: 'unknown',
        failureReason: 'Failed to create container',
      })
    ).toBe(false);
    // A reason that reads permanent: the cron gave up after the first failure.
    expect(
      songNeverReviewable({
        ingestion: 'Error',
        retryCount: 2,
        failureClass: null,
        failureReason: 'could not decode the file',
      })
    ).toBe(true);
  });
});
