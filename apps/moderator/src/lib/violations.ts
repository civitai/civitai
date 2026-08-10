/**
 * `/api/mod/remove-images` takes a violation ENUM plus a details string and forwards both onto the
 * ClickHouse `DeleteTOS` event. Sending only free text leaves a removal classified as nothing.
 * Mirrors `ViolationType` in the main app's `server/common/enums.ts`.
 */
export const VIOLATION_TYPES = [
  'realPerson',
  'realPersonNsfw',
  'realisticMinor',
  'realisticMinorNsfw',
  'animatedMinorNsfw',
  'schoolNsfw',
  'bestiality',
  'sexualViolence',
  'mindAlteredNsfw',
  'fecalMatter',
  'gore',
  'diaper',
  'anorexia',
  'bodilyFluids',
  'incest',
  'hate',
  'non-ai',
  'spam',
  'other',
] as const;
