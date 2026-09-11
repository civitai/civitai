/**
 * The verdicts a moderator can record on an abuse-detection finding.
 *
 * 🔴 IN `$lib`, NOT `$lib/server`, AND THAT IS A CONSTRAINT RATHER THAN A PREFERENCE. SvelteKit
 * refuses to bundle anything under `$lib/server` into client code, and the verdict buttons are
 * client code — so the tuple that renders them cannot live beside the table definition that
 * constrains them. Declaring it once here and importing it from BOTH sides is what keeps the page,
 * the form action and the database's CHECK constraint agreeing on one set. A second copy written
 * for the UI is how a fourth button appears that the database then refuses.
 *
 * Order is the order the UI offers them, and it is deliberate: the two real judgements first, the
 * abstention last.
 *
 * 🔴 THESE ARE NOT `actioned`/`action`. Those two record what the DETECTOR did, and are written by
 * the detector. These record whether a HUMAN thinks it was right. They move independently — the
 * commonest finding is one the detector left alone (`actioned: false`) and a moderator rules `tp` —
 * and nothing may read one to infer the other.
 *
 * `skip` is a DECISION ("I looked and I am not calling it"), which is why it is a verdict and not
 * simply left unruled. A NULL verdict means nobody has looked at all, and that is what a run's
 * "still to review" count is derived from.
 */
export const ABUSE_VERDICTS = ['tp', 'fp', 'skip'] as const;

export type AbuseVerdict = (typeof ABUSE_VERDICTS)[number];

/**
 * Narrowing guard — the one place an untrusted string becomes an `AbuseVerdict`.
 *
 * `includes` on the widened array rather than a hand-written `===` chain: a value added to the tuple
 * is covered here without anyone remembering to extend a second list.
 */
export const isAbuseVerdict = (value: unknown): value is AbuseVerdict =>
  typeof value === 'string' && (ABUSE_VERDICTS as readonly string[]).includes(value);
