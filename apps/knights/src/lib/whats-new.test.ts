import { describe, expect, it } from 'vitest';
import { whatsNewCopy } from './whats-new';

describe('whatsNewCopy', () => {
  it('tells a newcomer how the apprenticeship, gold and the Watch work for them', () => {
    const items = whatsNewCopy(false).items;
    expect(items[0].body).toBe(
      'Practice on images with known answers. Reach level 20 with 75% of your last 100 answers right to become a Knight.'
    );
    expect(items[1].body).toBe(
      'Each level you gain pays gold, and as a Knight, judging well pays more. Trade it for Buzz, Knights-only cosmetics or a week of membership perks.'
    );
    expect(items[2].lead).toBe("Once you're a Knight, keep the Watch.");
  });

  it('keeps the returning players copy as launched', () => {
    expect(whatsNewCopy(true)).toEqual({
      eyebrow: "What's new",
      title: 'Welcome to the new Knights of New Order',
      lead: "The Order has a new home. Here's what changed:",
      items: [
        { lead: 'Your rank and XP came with you.', body: 'Pick up where you left off.' },
        {
          lead: 'Earn gold, spend it in the shop.',
          body: 'Judging well pays gold. Trade it for Buzz, Knights-only cosmetics or a week of membership perks.',
        },
        {
          lead: 'Keep the Watch.',
          body: 'Judge 30 images a day to complete your Watch, build a streak for bonus gold, and get one free shield a week for a missed day.',
        },
        {
          lead: 'Climb higher.',
          body: 'A new rank sits above Templar: Paladin, with its own golden badge.',
        },
        {
          lead: 'Everything is in the Codex.',
          body: 'Ranks, the daily loop and the rating guide, all in one place.',
          link: { text: 'Codex', href: '/codex' },
        },
      ],
    });
  });
});
