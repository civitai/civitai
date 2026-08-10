import type { VIOLATION_TYPES } from '$lib/violations';

/**
 * Canned reasons whose `message` is sent verbatim to the user. Retool held these in `Function`
 * queries (`StrikeReasons`, `TosReasons`) rather than tables, which is why they appear in no query
 * inventory and were missed on the first pass.
 *
 * NOT in `$lib/server`: the pickers render them, and a component importing a server module drags the
 * database client into the client bundle.
 */
export type CannedReason = {
  label: string;
  /** Sent to the user as-is. `''` means the moderator supplies it. */
  message: string;
  /** Image flag this reason implies, where Retool set one alongside the removal. */
  flag?: 'poi' | 'minor' | 'tag';
  /**
   * `ViolationType` the removal is classified as. On the ROW, not in a lookup keyed by `label`:
   * `label` is prose that gets reworded, and a keyed map silently returns undefined when it does —
   * which files every removal under that reason with no classification at all.
   */
  violation?: (typeof VIOLATION_TYPES)[number];
};

/** Retool's `StrikeReasons`, bound to the strike modal's radio group. */
export const STRIKE_REASONS: CannedReason[] = [
  { label: 'Depicting Real People', message: 'Depicting real people is not allowed.' },
  {
    label: 'Real person model not marked correctly',
    message: "Real person models need to be marked as such and don't allow nsfw content.",
  },
  {
    label: 'Minor displayed in mature context',
    message: 'Minors displayed in mature context is not allowed.',
  },
  { label: 'Realistic minor', message: 'Realistic images of minors is not allowed.' },
  { label: 'Bestiality', message: 'Bestiality is not allowed.' },
  { label: 'Rape/Forced Sex', message: 'Depicting rape and domestic abuse is not allowed.' },
  {
    label: 'Non AI content',
    message:
      'CivitAI is for posting AI-generated images, go here to start generating some https://civitai.com/generate',
  },
  { label: 'Other', message: '' },
];

/** Retool's `TosReasons`, bound to `tosReasonsRadio` on Bulk Image Manager and User Reports. */
export const TOS_REASONS: CannedReason[] = [
  {
    label: 'Depicting Real People',
    message: 'Depicting real people is not allowed.',
    flag: 'poi',
    violation: 'realPerson',
  },
  {
    label: 'Minor displayed in mature context',
    message: 'Minors displayed in mature context is not allowed.',
    flag: 'minor',
    violation: 'animatedMinorNsfw',
  },
  {
    label: 'NSFW potential minor in a school environment',
    message: 'NSFW potential minors in a school environment is not allowed',
    violation: 'schoolNsfw',
  },
  {
    label: 'Realistic minor',
    message: 'Realistic images of minors is not allowed.',
    violation: 'realisticMinor',
  },
  {
    label: 'Bestiality',
    message: 'Bestiality is not allowed.',
    flag: 'tag',
    violation: 'bestiality',
  },
  {
    label: 'Rape/Forced Sex',
    message: 'Depicting rape and domestic abuse is not allowed.',
    violation: 'sexualViolence',
  },
  {
    label: 'Scat/Fecal matter',
    message:
      'Fecal matter, gaseous emission, object or lifeform being ejected from an anus is not allowed',
    violation: 'fecalMatter',
  },
  {
    label: 'Graphic Violence/Gore',
    message: 'Graphic Violence and/or gore is not allowed',
    violation: 'gore',
  },
  {
    label: 'Non AI content',
    message:
      'CivitAI is for posting AI-generated images or videos, go here to start generating some https://civitai.com/generate',
    violation: 'non-ai',
  },
  {
    label: 'Likeness/DMCA',
    message: 'Person depicted has requested to have images taken down',
    // The label-keyed map had no entry for this one, so DMCA removals filed unclassified.
    violation: 'other',
  },
  { label: 'Other', message: '' },
];
