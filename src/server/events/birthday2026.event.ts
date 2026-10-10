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
    // The 42-second cut. Its duration is the file's own (mvhd 42411 / 1000); re-read it on a new cut.
    heroVideo: { id: 'ecd5aeef-b4d5-497d-bdd7-51750c302122', title: 'Hats On', duration: 42.411 },
    dates: 'Nov 1 to Nov 30',
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
    prizeBadge: {
      Yellow: {
        animated: '5cf4f411-bb05-4afc-86b9-0ce9fbd8c683',
        static: 'c447b59d-bc02-4e7f-a83b-ad1efe3a70cf',
      },
      Blue: {
        animated: 'd0aedf96-8bb4-4837-9e22-f13662391e98',
        static: 'aa5ee01e-dfee-458a-9431-16c5e8656754',
      },
      Pink: {
        animated: '54cec518-332c-49cb-8584-359df0ff2ff8',
        static: '271a8ed5-46ae-47bc-8e63-7f913859bd3b',
      },
      Green: {
        animated: '3d5d9dea-c84a-4801-bf95-78dae8731010',
        static: '0c6d2d0a-ab63-45ee-925f-4019ee78db20',
      },
    },
    faq: [
      {
        question: 'What happens to my hats when the event ends?',
        answer:
          "You keep them. They stay on your content and you can still move them, they just stop scoring and aren't sold any more.",
      },
      {
        question: 'Do I keep hats bought during the tester and mod preview?',
        answer: 'Yes.',
      },
      {
        question: 'Can I change teams?',
        answer: 'No. Teams are assigned at random when you join and stay fixed.',
      },
    ],
  },
  banner: {
    accent: 'Pick up a hat.',
    text: 'Four colour teams, Nov 1 to Nov 30. Hat your best work and score for your team.',
    cta: 'Join a team',
    // The hero art's backdrop, so the strip runs on seamlessly to the left of the image.
    background: '#1c1a30',
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
