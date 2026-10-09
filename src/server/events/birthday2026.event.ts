import type { REDIS_KEYS } from '~/server/redis/client';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
  BIRTHDAY_2026_TEAMS,
} from '~/shared/constants/birthday2026.constants';
import { createEvent } from './base.event';

// The event name is the redis key, the PRNG seed for team assignment, the cosmetics' data.event and
// the page slug. Typed against the REDIS_KEYS entry so the two strings cannot drift apart.
const name: (typeof REDIS_KEYS)['BIRTHDAY']['2026']['BASE'] = BIRTHDAY_2026_EVENT;

export const birthday2026 = createEvent(name, {
  title: "Civitai's 4th Birthday",
  // Copies: consumers must never be able to mutate the shared constants.
  startDate: new Date(BIRTHDAY_2026_STARTS_AT.getTime()),
  endDate: new Date(BIRTHDAY_2026_ENDS_AT.getTime()),
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
