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
 * the detector. These record a HUMAN's judgement OF THE ACCOUNT: `tp` is "this account is abusing the
 * site", `fp` is "this account is fine". They move independently of the detector's columns — the
 * commonest finding is one the detector left alone (`actioned: false`) and a moderator rules `tp` —
 * and nothing may read one to infer the other.
 *
 * 🔴 THE CODES ARE DETECTOR-ERA JARGON AND THE MEANING IS NOT. `tp`/`fp` were named for the
 * detector's correctness, and under that reading the verdict INVERTED across this board: on a
 * flagged-but-unactioned finding `tp` meant "abuse", while on a `confidence = 0` finding — where the
 * detector's reason opens "Judged and deliberately NOT actioned", i.e. it decided the account was FINE
 * — the same `tp` meant "NOT abuse". The question is now about the account, so there is one answer in
 * both populations. The STORED CODES were deliberately left alone: they are the values the table's
 * CHECK constraint admits, and renaming them would be a hand-applied migration buying nothing. Read
 * `tp` as "abuse" and `fp` as "not abuse" — never as a claim about the detector.
 *
 * 🔴 "NO MIGRATION IS OWED" IS A CONDITION, NOT A FACT, AND THIS IS THE QUERY THAT SETTLES IT:
 *
 *     SELECT count(*) FROM abuse_detection_finding WHERE confidence = 0 AND verdict IS NOT NULL;
 *
 * It was 0 when the relabel was written — every verdict on record sat in the flagged-but-unactioned
 * population, where the old reading and the new one agree, so no stored row changed meaning. Nothing
 * enforces that: those rows ARE rulable today, and a non-zero count means some moderator's ruling now
 * renders as the OPPOSITE of what they clicked, with their name and timestamp beside it. Re-run it
 * before trusting this paragraph, and any time the question comes up again.
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
