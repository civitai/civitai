import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '@civitai/shared';
import { disputeOutcome, imageCaption, ordinal } from '../rating-dispute';

const { PG, PG13, R } = NsfwLevel;

describe('disputeOutcome', () => {
  it('approves only when the owner’s ask is applied, whatever it does to the rating', () => {
    expect(disputeOutcome('Post', { current: R, suggested: PG13, chosen: PG13 })).toEqual({
      approves: true,
      label: 'Approves dispute',
      effect: 'Lowers to PG-13.',
    });
    expect(disputeOutcome('Post', { current: R, suggested: PG13, chosen: PG })).toMatchObject({
      approves: false,
      label: 'Rejects dispute',
      effect: 'Lowers to PG.',
    });
  });

  it('says a refusal keeps the current rating and a higher level raises it', () => {
    expect(disputeOutcome('Article', { current: PG13, suggested: PG, chosen: PG13 })).toMatchObject(
      {
        approves: false,
        effect: 'Keeps PG-13.',
      }
    );
    expect(disputeOutcome('Article', { current: PG, suggested: R, chosen: R })).toMatchObject({
      approves: true,
      effect: 'Raises to R.',
    });
  });

  it('describes a model or collection by its SFW or NSFW flag', () => {
    expect(disputeOutcome('Model', { current: PG, suggested: R, chosen: R })).toMatchObject({
      approves: true,
      effect: 'Sets model to NSFW.',
    });
    expect(disputeOutcome('Collection', { current: R, suggested: PG, chosen: R })).toMatchObject({
      approves: false,
      effect: 'Keeps NSFW.',
    });
  });
});

describe('ordinal', () => {
  it('handles the teens and the 1/2/3 endings', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 102, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '102nd',
      '111th',
    ]);
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
