import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '@civitai/shared';
import { disputeOutcome, imageCaption, isNsfwRating, recordedVerdict } from '../rating-dispute';

const { PG, PG13, R } = NsfwLevel;

describe('isNsfwRating', () => {
  it('treats PG and PG-13 as safe and R and above as NSFW', () => {
    expect([PG, PG13].map(isNsfwRating)).toEqual([false, false]);
    expect([R, NsfwLevel.X, NsfwLevel.XXX].map(isNsfwRating)).toEqual([true, true, true]);
  });
});

describe('disputeOutcome', () => {
  it('rejects with nothing applied when the entity is gone, whatever level is chosen', () => {
    expect(disputeOutcome('Post', { current: R, suggested: PG13, chosen: PG13 }, false)).toEqual({
      approves: false,
      label: 'Rejects dispute',
      effect: 'Content was deleted; nothing will be applied.',
    });
  });

  it('approves only when the owner’s ask is applied, whatever it does to the rating', () => {
    expect(disputeOutcome('Post', { current: R, suggested: PG13, chosen: PG13 }, true)).toEqual({
      approves: true,
      label: 'Approves dispute',
      effect: 'Lowers to PG-13.',
    });
    expect(disputeOutcome('Post', { current: R, suggested: PG13, chosen: PG }, true)).toMatchObject(
      {
        approves: false,
        label: 'Rejects dispute',
        effect: 'Lowers to PG.',
      }
    );
  });

  it('says a refusal keeps the current rating and a higher level raises it', () => {
    expect(
      disputeOutcome('Article', { current: PG13, suggested: PG, chosen: PG13 }, true)
    ).toMatchObject({
      approves: false,
      effect: 'Keeps PG-13.',
    });
    expect(disputeOutcome('Article', { current: PG, suggested: R, chosen: R }, true)).toMatchObject(
      {
        approves: true,
        effect: 'Raises to R.',
      }
    );
  });

  it('describes a model or collection by its SFW or NSFW flag', () => {
    expect(disputeOutcome('Model', { current: PG, suggested: R, chosen: R }, true)).toMatchObject({
      approves: true,
      effect: 'Sets model to NSFW.',
    });
    expect(
      disputeOutcome('Collection', { current: R, suggested: PG, chosen: R }, true)
    ).toMatchObject({
      approves: false,
      effect: 'Keeps NSFW.',
    });
  });

  it('keeps a flag when the stored level and the chosen one read as the same SFW or NSFW label', () => {
    expect(
      disputeOutcome('Model', { current: NsfwLevel.X, suggested: PG, chosen: R }, true)
    ).toMatchObject({
      approves: false,
      effect: 'Keeps NSFW.',
    });
    expect(
      disputeOutcome('Model', { current: PG, suggested: PG, chosen: PG13 }, true)
    ).toMatchObject({
      approves: false,
      effect: 'Keeps SFW.',
    });
  });
});

describe('imageCaption', () => {
  it('counts the images of the types that list several and names the single-cover ones', () => {
    expect(imageCaption('Post', 12)).toEqual({
      title: 'IMAGES (12)',
      hint: 'a post is rated by its highest image',
    });
    expect(imageCaption('Challenge', 1).title).toBe('COVER');
    expect(imageCaption('Bounty', 4).title).toBe('IMAGES');
  });
});

describe('recordedVerdict', () => {
  it('relabels the optimistic verdict with what the server recorded', () => {
    expect(recordedVerdict('Unactioned', 'Approved: applied PG')).toBe('Rejected: applied PG');
    expect(recordedVerdict('Actioned', 'Rejected: applied R')).toBe('Approved: applied R');
    expect(recordedVerdict('Actioned', 'Approved: applied R')).toBe('Approved: applied R');
  });

  it('keeps the optimistic verdict when the result carries no known status', () => {
    expect(recordedVerdict(undefined, 'Approved: applied R')).toBe('Approved: applied R');
    expect(recordedVerdict('Pending', 'Approved: applied R')).toBe('Approved: applied R');
  });
});
