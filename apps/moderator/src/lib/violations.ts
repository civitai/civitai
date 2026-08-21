import { z } from 'zod';

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

/** The moderator-facing wording, mirroring the main app's `TOS_REASONS`. A `Record` over the union so
 *  a value added above without a label fails the build rather than rendering as its enum key. */
export const VIOLATION_LABELS: Record<(typeof VIOLATION_TYPES)[number], string> = {
  realPerson: 'Depicting Real People',
  realPersonNsfw: 'Depicting Real People in Mature Context',
  realisticMinor: 'Realistic Minor',
  realisticMinorNsfw: 'Realistic Minor in Mature Context',
  animatedMinorNsfw: 'Illustrated Minor in Mature Context',
  schoolNsfw: 'NSFW Minor in School Environment',
  bestiality: 'Bestiality',
  sexualViolence: 'Sex Violence',
  mindAlteredNsfw: 'Mind-Altered NSFW',
  fecalMatter: 'Scat/Fecal Matter',
  gore: 'Graphic Violence/Gore',
  diaper: 'Diapers',
  anorexia: 'Anorexia',
  bodilyFluids: 'Prohibited Bodily Fluids',
  incest: 'Incest',
  hate: 'Hate Speech/Extreme Political',
  'non-ai': 'Non-AI Content',
  spam: 'Spam',
  other: 'Other',
};

/**
 * The pair every removal action posts. `violationType` is a ClickHouse enum on the other side, so an
 * unrecognised value is refused rather than forwarded as free text — a removal filed under nothing is
 * indistinguishable from one nobody classified.
 */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

export const violationInputSchema = z.object({
  violationType: z.preprocess(emptyToUndefined, z.enum(VIOLATION_TYPES).optional()),
  violationDetails: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
});
