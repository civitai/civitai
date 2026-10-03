/**
 * THE THREE SUB-ANALYSES AN APP-BLOCK AGENT REVIEW PRODUCES — one ledger, every consumer.
 *
 * 🔴 THIS EXISTS BECAUSE THE SET WAS SPELLED FOUR TIMES AND NOTHING PINNED THE COPIES
 * EQUAL. The report row has one Json column per entry, and before this module the same
 * three strings were written out in the tRPC input schema (as a zod enum), in the
 * provisioning service (as a tuple it takes `.length` from), in the client view-model (as
 * the list every per-section derivation maps over), and as an `if` chain in the callback
 * that writes them. Each copy's docstring pointed at the others — the duplication was seen
 * and documented rather than removed. All four now read this module — the callback included,
 * which is the copy whose divergence is silent ON WRITE.
 *
 * 🔴 THE DIVERGENCE IS SILENT IN BOTH DIRECTIONS, which is why one place now owns it.
 * `startAgentReview` classifies a dispatch as TARGETED with
 * `0 < requested.length < AGENT_REVIEW_SECTIONS.length`. Add a fourth analysis to the zod
 * enum and miss the service's tuple, and a moderator selecting all four is classified
 * *targeted* — so it takes the carry-forward path and seeds stale sections into what is
 * actually a full re-run, the one thing that path's own comment says must never happen.
 * Miss the callback instead and the fourth section's results are dropped on write. Neither
 * reddens anything.
 *
 * 🔴 IT LIVES IN `~/shared/constants` SO THE DEPENDENCY NEVER INVERTS. The server schema,
 * the provisioning service and the client renderer all need it, and a server module must
 * not import a client view-model (nor the reverse). `block-scope.constants.ts` next door is
 * the established precedent for exactly this shape. Keep this file free of zod, Prisma and
 * React so every one of those consumers can take it.
 */

/** The three analyses, in DISPLAY ORDER. */
export const AGENT_REVIEW_SECTIONS = ['scopeVerdicts', 'securityAudit', 'codeReview'] as const;

export type AgentReviewSection = (typeof AGENT_REVIEW_SECTIONS)[number];

export function isAgentReviewSection(value: unknown): value is AgentReviewSection {
  return typeof value === 'string' && (AGENT_REVIEW_SECTIONS as readonly string[]).includes(value);
}

/**
 * What a moderator is shown for each analysis.
 *
 * 🔴 ONE SOURCE FOR THE LABELS TOO. The report's own tab bar used to type these three
 * strings inline while the partial-failure banner read them from here — so the two could
 * disagree about one analysis on one screen.
 */
export const AGENT_REVIEW_SECTION_LABELS: Record<AgentReviewSection, string> = {
  scopeVerdicts: 'Scopes',
  securityAudit: 'Security audit',
  codeReview: 'Code review',
};

/** How much of a stored failure message is ever surfaced. */
export const AGENT_SECTION_ERROR_MAX_CHARS = 500;

/**
 * Extract a FAILURE MESSAGE from a stored section slot, or `null` when the slot is absent
 * or well-formed.
 *
 * The runner persists each section verbatim and writes `{ error: … }` — or, on a crash, a
 * bare string log dump — when that sub-analysis failed. The tolerant Zod parse in
 * `agentReviewReport.ts` would quietly flatten either to an EMPTY section, which is
 * indistinguishable from "this analysis ran and found nothing", so this STRUCTURAL check has
 * to run on the raw slot first.
 *
 * 🔴 ONE PREDICATE, SERVER AND CLIENT. The server's carry-forward (which must not seed an
 * old failure forward as fresh content) and the client's per-section status used to spell
 * this separately. The failure encodings are written by a runner in a different repo that
 * can add one at any time; taught to one copy and not the other, the server stops
 * recognising a failed slot and seeds it forward as good content — exactly the outcome the
 * carry-forward exists to prevent.
 *
 * ⚠️ THE VALUE IS ADVERSARIAL — produced while processing an untrusted, prompt-injectable
 * bundle. It is returned as a plain string, bounded, and must only ever be rendered as inert
 * text.
 */
export function agentSectionFailureMessage(raw: unknown): string | null {
  if (raw == null) return null;
  // A bare string in a structured slot is a runner failure / log dump, not data.
  //
  // 🔴 A WHITESPACE-ONLY STRING IS STILL A FAILURE, and it used to read as a clean section.
  // The old `s ? … : null` returned null for `'   '`, which scored the slot `complete` — so
  // the panel rendered "No security-audit findings." for an analysis that returned nothing
  // but blanks. That is precisely the "did it run, or did it find nothing?" conflation this
  // whole surface exists to remove, and a string slot is unambiguous evidence the runner
  // wrote a dump rather than a result. The message says so rather than showing empty space.
  if (typeof raw === 'string') {
    // 🔴 SLICE BEFORE TRIM. The other order copies the WHOLE string first, and this runs ~15×
    // per render of the agent surface (four section-status walks plus three message lookups,
    // each over three slots) — so a multi-MB bare-string log dump would be duplicated fifteen
    // times a frame to produce 500 characters. Same output for any input: trailing whitespace
    // inside the first 500 chars is still trimmed, and a string of pure whitespace still
    // reduces to empty.
    const s = raw.slice(0, AGENT_SECTION_ERROR_MAX_CHARS).trim();
    return s ? s : 'the analysis returned no output';
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if ('error' in o && o.error != null) {
      const e = o.error;
      const msg = typeof e === 'string' ? e : JSON.stringify(e);
      // 🔴 A NON-EMPTY RESULT IS GUARANTEED once the `error` key is present and non-null.
      // `{ error: '' }` used to make the extractor return `''`, which scored the section
      // FAILED on a `!= null` test while every renderer's `if (error)` read it as falsy —
      // a tab badged "failed" above a body showing the clean empty state, with no retry
      // control. An error that carries no words is still an error; say so.
      // 🔴 `.trim()` BEFORE THE LENGTH TEST, or `{ error: '   ' }` returns three spaces: the
      // section scores `failed`, the renderer's `if (error)` sees a truthy string, and the
      // moderator gets a "failed" badge above a BLANK reason — the same no-information shape
      // the `{ error: '' }` case two lines down exists to close, and the same decision the
      // bare-string arm above already takes. An error that carries no words is still an error.
      const trimmed = msg.trim();
      return trimmed.length > 0
        ? trimmed.slice(0, AGENT_SECTION_ERROR_MAX_CHARS)
        : 'unspecified error';
    }
  }
  return null;
}

/** Whether a stored section slot is a failure marker rather than a result. */
export function isAgentSectionFailureMarker(raw: unknown): boolean {
  return agentSectionFailureMessage(raw) != null;
}

/**
 * Known machine-readable section error CODES → what to tell a moderator.
 *
 * 🔴 `null`-PROTOTYPE, AND THAT IS A SAFETY REQUIREMENT RATHER THAN A STYLE CHOICE. The key
 * is an ADVERSARIAL string straight out of the report, so a plain object literal resolves
 * inherited `Object.prototype` members through the lookup: a handful of key names return a
 * function or an object where the signature promises a string. Rendered as a React child
 * that is a crash of the whole review surface (there is no error boundary above it) or a
 * silently dropped reason — the exact opposite of the verbatim guarantee below. The
 * `Object.create(null)` base plus the `typeof` narrowing in {@link agentSectionErrorMessage}
 * are two independent closes on it; keep both.
 *
 * `truncated-response` is a code the agent runner is gaining in a companion infra change.
 * Until that ships this entry simply never matches, which is the degradation we want.
 *
 * The two are worth separating because they call for different actions: a non-JSON response
 * means the model answered in prose where a schema was required, and a re-run usually fixes
 * it; a truncated response was cut off mid-structure, which is a size problem that will
 * usually recur.
 */
export const AGENT_SECTION_ERROR_MESSAGES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    'non-json-response':
      'The analysis replied in prose instead of the structured format, so nothing could be ' +
      'read from it. Re-running this one analysis usually clears it.',
    'truncated-response':
      'The analysis reply was cut off before it finished, so the structured result is ' +
      'incomplete. This is usually a size problem rather than a transient one — re-running ' +
      'the same bundle will often truncate again.',
  }
);

/**
 * The moderator-facing message for a failed section, or `null` when it did not fail.
 *
 * 🔴 AN UNRECOGNISED ERROR IS SHOWN VERBATIM, NEVER REPLACED BY A GENERIC LINE. The stored
 * value is the only evidence a moderator has about why an analysis produced nothing, and the
 * codes are written by a runner in a different repo that can add one at any time. A table
 * lookup that fell back to "the analysis failed" would turn every future code into no
 * information at all.
 *
 * 🔴 THE `typeof` NARROWING IS THE SECOND CLOSE ON THE PROTOTYPE HOLE above. Even against a
 * table that somehow carried a non-string, this returns the raw (bounded) error rather than
 * handing a function or an object to a React child.
 */
export function agentSectionErrorMessage(raw: unknown): string | null {
  const error = agentSectionFailureMessage(raw);
  if (error == null) return null;
  const mapped = AGENT_SECTION_ERROR_MESSAGES[error];
  return typeof mapped === 'string' ? mapped : error;
}
