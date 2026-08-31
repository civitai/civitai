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
  /**
   * The ToS clause the reason is for, so a struck user can be shown WHICH terms they broke.
   *
   * The SECTION, never the lettered bullet: `tos.green.md` inserts an adult-content clause at 9.6(a)
   * and pushes the rest down, so 9.6(a) on civitai.com is 9.6(b) on the green domain. Section numbers
   * are identical across variants; letters are not.
   *
   * Absent means the ToS does not cover it — `Non AI content` is the real case: nothing in the terms
   * requires uploads to be AI-generated, and the moderation team chose to leave it that way
   * (2026-08-24) rather than add a clause.
   */
  tos?: TosSection;
};

/** Sections a canned reason can cite. A closed union so a typo does not ship as a dangling citation. */
export type TosSection = '9.6' | '11.2' | '11.8';

/** Retool's `StrikeReasons`, bound to the strike modal's radio group. */
export const STRIKE_REASONS: CannedReason[] = [
  { label: 'Depicting Real People', message: 'Depicting real people is not allowed.', tos: '9.6' },
  {
    label: 'Real person model not marked correctly',
    message: "Real person models need to be marked as such and don't allow nsfw content.",
    tos: '9.6',
  },
  {
    label: 'Minor displayed in mature context',
    message: 'Minors displayed in mature context is not allowed.',
    tos: '9.6',
  },
  { label: 'Realistic minor', message: 'Realistic images of minors is not allowed.', tos: '9.6' },
  { label: 'Bestiality', message: 'Bestiality is not allowed.', tos: '9.6' },
  {
    label: 'Rape/Forced Sex',
    message: 'Depicting rape and domestic abuse is not allowed.',
    tos: '9.6',
  },
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
    tos: '9.6',
  },
  {
    label: 'Minor displayed in mature context',
    message: 'Minors displayed in mature context is not allowed.',
    flag: 'minor',
    violation: 'animatedMinorNsfw',
    tos: '9.6',
  },
  {
    label: 'NSFW potential minor in a school environment',
    message: 'NSFW potential minors in a school environment is not allowed',
    violation: 'schoolNsfw',
    tos: '9.6',
  },
  {
    label: 'Realistic minor',
    message: 'Realistic images of minors is not allowed.',
    violation: 'realisticMinor',
    tos: '9.6',
  },
  {
    label: 'Bestiality',
    message: 'Bestiality is not allowed.',
    flag: 'tag',
    violation: 'bestiality',
    tos: '9.6',
  },
  {
    label: 'Rape/Forced Sex',
    message: 'Depicting rape and domestic abuse is not allowed.',
    violation: 'sexualViolence',
    tos: '9.6',
  },
  {
    label: 'Scat/Fecal matter',
    message:
      'Fecal matter, gaseous emission, object or lifeform being ejected from an anus is not allowed',
    violation: 'fecalMatter',
    tos: '9.6',
  },
  {
    label: 'Graphic Violence/Gore',
    message: 'Graphic Violence and/or gore is not allowed',
    violation: 'gore',
    tos: '9.6',
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
    // 9.3(b)(i) and §12 are the real citation, but the modal anchors at section level and neither is
    // the prohibited-content list — better to cite nothing than to send them to the wrong section.
  },
  { label: 'Other', message: '' },
];
