import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

// The event whose hats can be showcased on avatars (src/server/events/showcase-hat.ts). Shared by the
// server and the roster cards, which draw nothing showcase-specific outside this window.
// shortcut: one event, by constant. Make it a field on the event definition when a second event wants it.
export const SHOWCASE_EVENT = {
  name: BIRTHDAY_2026_EVENT,
  startDate: BIRTHDAY_2026_STARTS_AT,
  endDate: BIRTHDAY_2026_ENDS_AT,
} as const;

export const isShowcaseLive = (now = new Date()) =>
  now >= SHOWCASE_EVENT.startDate && now < SHOWCASE_EVENT.endDate;
