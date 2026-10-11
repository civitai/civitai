// Shared by the event definition (server) and the cosmetic/shop UI (client), so it must stay free of
// server imports.

export const BIRTHDAY_2026_EVENT = 'birthday2026';

// A user's team is a seeded PRNG index into this array, so adding, removing or reordering teams
// reassigns every user. Team names are also stored in cosmetic names, cached cosmetic ids, manual
// team assignments and Discord role names: rename only before launch, or migrate all of those.
export const BIRTHDAY_2026_TEAMS = ['Yellow', 'Blue', 'Pink', 'Green'] as const;
export type Birthday2026Team = (typeof BIRTHDAY_2026_TEAMS)[number];

// All of November, UTC. ENDS_AT is exclusive.
export const BIRTHDAY_2026_STARTS_AT = new Date('2026-11-01T00:00:00.000Z');
export const BIRTHDAY_2026_ENDS_AT = new Date('2026-12-01T00:00:00.000Z');
// Users the `birthday2026` flag is on for (testers and moderators) play from here until the start.
export const BIRTHDAY_2026_PREVIEW_FROM = new Date('2026-10-09T00:00:00.000Z');
