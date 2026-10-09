import type { REDIS_KEYS } from '~/server/redis/client';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
  BIRTHDAY_2026_TEAMS,
} from '~/shared/constants/birthday2026.constants';
import { EVENT_DECORATION_DEFINITIONS } from '~/shared/constants/event-decoration.constants';
import { createEvent } from './base.event';

// The event name is the redis key, the PRNG seed for team assignment, the cosmetics' data.event and
// the page slug. Typed against the REDIS_KEYS entry so the two strings cannot drift apart.
const name: (typeof REDIS_KEYS)['BIRTHDAY']['2026']['BASE'] = BIRTHDAY_2026_EVENT;

// The page states the wait the placement service enforces, read from the same definition.
const moveCooldownMin =
  (EVENT_DECORATION_DEFINITIONS.find((d) => d.event === BIRTHDAY_2026_EVENT)?.moveCooldownMs ?? 0) /
  60_000;

export const birthday2026 = createEvent(name, {
  title: "Civitai's 4th Birthday",
  page: {
    headline: 'Civitai turns 4.',
    headlineAccent: 'Pick up a hat.',
    heroImage: '4a5e404d-ece2-4cca-bbab-cb5a7b0d8d9d',
    dates: 'Nov 11 to Nov 25',
    summary:
      'Four colour teams. Put party hats on your images, models and articles, and every view and reaction they get scores for your team.',
    steps: [
      {
        title: 'Join',
        body: 'You land on one of four teams at random and get a free Party Cap in your colour. Your team is yours for the whole event.',
      },
      {
        title: 'Hat your best work',
        body: `Each hat sits on one of your own posts at a time, alongside any frame. Move it any time, with a ${moveCooldownMin}-minute wait between moves.`,
      },
      {
        title: 'Score for your team',
        body: 'While your content wears a hat, its views and reactions count for your team. More hats on more content means more chances to score.',
      },
    ],
    prize: {
      title: 'Birthday 2026 Champion badge',
      body: 'An animated badge in the winning colour, for every member of the winning team whose hats earned points.',
    },
    faq: [
      {
        question: 'What happens to my hats when the event ends?',
        answer: 'They come off your content and stop scoring.',
      },
      {
        question: 'Can I change teams?',
        answer: 'No. Teams are assigned at random when you join and stay fixed.',
      },
    ],
  },
  // Copies: consumers must never be able to mutate the shared constants.
  startDate: new Date(BIRTHDAY_2026_STARTS_AT.getTime()),
  endDate: new Date(BIRTHDAY_2026_ENDS_AT.getTime()),
  // Behind the flag; flagged users play from previewFrom. See event-access.ts.
  featureFlag: 'birthday2026',
  previewFrom: new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime()),
  teams: BIRTHDAY_2026_TEAMS,
  // Display name only; the join cosmetic is found by data (event, team, design).
  cosmeticName: 'Party Cap',
  join: { claimKey: 'claimed', design: 'basic' },
  badgePrefix: 'Birthday 2026',
  scoring: {
    reactionWeight: 10,
    anonFloor: 10,
    anonRatio: 1,
    botSessionEntityLimit: 1500,
    newAccountDays: 7,
    viewerOwnerDailyCap: 50,
    finalizeAfterMs: 24 * 60 * 60 * 1000,
  },
});
