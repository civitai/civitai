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
