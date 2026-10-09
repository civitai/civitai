// Shared by the event definition (server) and the cosmetic/shop UI (client), so it must stay free of
// server imports.

export const BIRTHDAY_2026_EVENT = 'birthday2026';

// Order is load-bearing: a user's team is a seeded PRNG index into this array. Renaming a team is
// safe; reordering or inserting after launch reassigns every user.
export const BIRTHDAY_2026_TEAMS = ['Yellow', 'Blue', 'Pink', 'Green'] as const;
export type Birthday2026Team = (typeof BIRTHDAY_2026_TEAMS)[number];

// Pacific midnight, Nov 11 through the end of Nov 25. ENDS_AT is exclusive.
export const BIRTHDAY_2026_STARTS_AT = new Date('2026-11-11T08:00:00.000Z');
export const BIRTHDAY_2026_ENDS_AT = new Date('2026-11-26T08:00:00.000Z');
