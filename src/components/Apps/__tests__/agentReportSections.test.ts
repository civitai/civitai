import { describe, expect, test } from 'vitest';
import {
  AGENT_REPORT_SECTIONS,
  AGENT_REPORT_SECTION_LABELS,
  AGENT_SECTION_ERROR_MESSAGES,
  agentReportSectionStatuses,
  failedAgentReportSections,
  hasUsableAgentReportSection,
  isAgentReportSection,
  missingAgentReportSections,
  sectionAnalysisError,
  sectionErrorMessage,
  degradedReportSummary,
} from '~/components/Apps/agentReviewReport';

/**
 * PER-SECTION report status, in the node-env `unit` project.
 *
 * 🔴 WHAT THIS EXISTS TO STOP. The agent runner marks the WHOLE report `failed` when any
 * ONE of its three analyses fails, and the panel took that at face value: it rendered a red
 * "the agentic review failed" banner and nothing else, so a moderator lost a complete
 * security audit and a complete scope trace because the code review came back as prose.
 * Measured on live rows: 4 of 11 runs were `failed`, and the most recent of those had
 * `code_review = {"error":"non-json-response"}` beside two sections with real content.
 *
 * The REALISTIC fixture below is that exact row's shape, not a textbook one.
 */

/** The live failure shape: two good sections, one `{ error }`. */
const PARTIAL = {
  status: 'failed',
  scopeVerdicts: {
    scopes: [{ declared: 'models:read:self', used: 'yes', justificationAccurate: 'yes' }],
    overBroad: [],
    underDeclared: [],
  },
  securityAudit: {
    findings: [{ severity: 'low', title: 'console.log left in', evidence: [] }],
    manifestUnexpectedKeys: [],
    iframeSandboxGrants: [],
    promptInjectionAttempts: [],
  },
  codeReview: { error: 'non-json-response' },
};

describe('the section ledger', () => {
  test('🔴 is exactly these three (fails when it GROWS or SHRINKS)', () => {
    expect([...AGENT_REPORT_SECTIONS]).toEqual(['scopeVerdicts', 'securityAudit', 'codeReview']);
  });

  test('each has a label, and the guard accepts members only', () => {
    for (const s of AGENT_REPORT_SECTIONS) {
      expect(AGENT_REPORT_SECTION_LABELS[s]).toBeTruthy();
      expect(isAgentReportSection(s)).toBe(true);
    }
    for (const junk of ['summary', 'codereview', '', null, 0, {}]) {
      expect(isAgentReportSection(junk)).toBe(false);
    }
  });
});

describe('agentReportSectionStatuses', () => {
  test('🔴 THE LIVE PARTIAL FAILURE: two complete, one failed — on a row whose status is `failed`', () => {
    expect(agentReportSectionStatuses(PARTIAL)).toEqual({
      scopeVerdicts: 'complete',
      securityAudit: 'complete',
      codeReview: 'failed',
    });
  });

  test('an absent / null slot is `missing`, which is NOT `failed`', () => {
    // A torn-down run, or one that never reached this analysis. Reporting it as a failure
    // would send a mod chasing an error that was never written.
    expect(agentReportSectionStatuses({})).toEqual({
      scopeVerdicts: 'missing',
      securityAudit: 'missing',
      codeReview: 'missing',
    });
    expect(agentReportSectionStatuses({ codeReview: null }).codeReview).toBe('missing');
  });

  test('🔴 AN EMPTY-BUT-PRESENT SECTION IS `complete` — "found nothing" IS a result', () => {
    // This is the distinction the tolerant parse destroys: it flattens `{ error }` to an
    // empty section, making a broken analysis indistinguishable from a clean one. Reading
    // the RAW slot is what keeps the two apart, in both directions.
    expect(
      agentReportSectionStatuses({ codeReview: { findings: [], priorFindingsReconciled: [] } })
        .codeReview
    ).toBe('complete');
  });

  test('🔴 a BARE STRING in a structured slot is a runner log dump — `failed`, whitespace included', () => {
    expect(agentReportSectionStatuses({ securityAudit: 'Traceback…' }).securityAudit).toBe(
      'failed'
    );
    // ⚠️ AND A BLANK ONE TOO. An earlier version of this test asserted `complete` here, with
    // a comment rationalising it as "carries no information" — which is exactly the defect
    // this module exists to remove, rendered as a clean verdict: the panel showed
    // "No security-audit findings." for an analysis whose slot held whitespace. The STRING
    // is the signal, not its contents.
    expect(agentReportSectionStatuses({ securityAudit: '   ' }).securityAudit).toBe('failed');
    expect(agentReportSectionStatuses({ securityAudit: '' }).securityAudit).toBe('failed');
  });

  test('🔴 `{ error: "" }` is `failed` AND carries a message the renderer can show', () => {
    // The disagreement this closes: the extractor returned `''`, so the status check
    // (`!= null`) scored the section FAILED while every renderer's `if (error)` read it as
    // falsy — a tab badged "failed" above a body showing the clean empty state, with no
    // retry control on it.
    expect(agentReportSectionStatuses({ codeReview: { error: '' } }).codeReview).toBe('failed');
    // 🔴 THE TWO MUST AGREE. A status of `failed` whose message is falsy is the bug: the
    // renderer branches on `if (error)` and would paint the clean empty state under a
    // "failed" tab badge.
    expect(sectionErrorMessage({ error: '' })).toBe('unspecified error');
    expect(sectionErrorMessage('   ')).toBe('the analysis returned no output');
  });

  /**
   * 🔴 THE REASON SURVIVES LEADING BLANK LINES, which is the whole value of the slot.
   *
   * An earlier revision sliced to the 500-character bound BEFORE trimming, on a perf
   * argument that was later benchmarked at zero (V8's `trim()` returns the original string,
   * or a constant-size view — it never copies). The cost was real though: the budget got
   * spent on whitespace, so a runner dump that starts with blank lines reduced to the
   * generic "returned no output" line. That is the only evidence a moderator has about WHY
   * an analysis produced nothing, and losing it re-opens the "did it run, or did it find
   * nothing?" conflation this whole surface exists to close.
   *
   * Both fixtures overshoot the bound deliberately — 600 and 400 are not multiples of the
   * 500-character step, so neither can land exactly on it and pass by accident.
   */
  test('🔴 a dump that STARTS with whitespace keeps its reason — the budget is not spent on blanks', () => {
    const reason = 'Traceback: OOM in sandbox runner';
    expect(sectionErrorMessage('\n'.repeat(600) + reason)).toBe(reason);
    // …and a long message behind leading spaces is surfaced in full, not truncated to what
    // was left over after the padding.
    const long = 'E'.repeat(400);
    expect(sectionErrorMessage(' '.repeat(400) + long)).toBe(long);
    // The bound itself still applies to the TRIMMED text.
    expect(sectionErrorMessage('X'.repeat(900))).toHaveLength(500);
  });

  /**
   * 🔴 A SCALAR OR AN ARRAY IN A STRUCTURED SLOT IS NOT A RESULT EITHER.
   *
   * Every one of the three analyses stores an object with named fields, so `0`, `false` and
   * `[]` can only come from a runner that wrote the wrong thing. They used to fall through
   * to `null`, which scores the slot `complete` and renders the clean "no findings" empty
   * state — the same false clean verdict as the whitespace case above, arriving by a
   * different route.
   */
  test('🔴 a NON-OBJECT or ARRAY slot is a failure, not a clean section', () => {
    // Four DISTINCT shapes. An earlier version's fourth element was `'x'.length - 1`, which
    // evaluates to `0` — a duplicate of the first, dressed as a separate case.
    for (const bogus of [0, false, [], true]) {
      expect(agentReportSectionStatuses({ codeReview: bogus }).codeReview).toBe('failed');
      expect(sectionErrorMessage(bogus)).toBe('the analysis returned no result');
    }
    // 🔴 THE CONTRAST, or the rule above would be satisfied by scoring EVERYTHING failed:
    // a plain object with no `error` key is the legitimate completed shape and stays clean.
    expect(agentReportSectionStatuses({ codeReview: { findings: [] } }).codeReview).toBe(
      'complete'
    );
    expect(sectionErrorMessage({ findings: [] })).toBeNull();
  });
});

describe('failedAgentReportSections', () => {
  test('names the broken ones, in display order', () => {
    expect(failedAgentReportSections(PARTIAL)).toEqual(['codeReview']);
    expect(
      failedAgentReportSections({
        scopeVerdicts: { error: 'x' },
        securityAudit: { findings: [] },
        codeReview: { error: 'y' },
      })
    ).toEqual(['scopeVerdicts', 'codeReview']);
  });

  test('🔴 NEGATIVE CONTROL: a fully-good report names none', () => {
    expect(failedAgentReportSections({ ...PARTIAL, codeReview: { findings: [] } })).toEqual([]);
  });
});

describe('hasUsableAgentReportSection — the gate on showing a failed report at all', () => {
  test('🔴 TRUE for the live partial row: the body must be rendered, not replaced by a banner', () => {
    expect(hasUsableAgentReportSection(PARTIAL)).toBe(true);
  });

  test('🔴 FALSE when EVERYTHING failed — then the whole-report banner IS the honest surface', () => {
    expect(
      hasUsableAgentReportSection({
        scopeVerdicts: { error: 'a' },
        securityAudit: { error: 'b' },
        codeReview: { error: 'c' },
      })
    ).toBe(false);
  });

  test('FALSE for an empty report row (nothing was ever written)', () => {
    expect(hasUsableAgentReportSection({})).toBe(false);
  });

  test('TRUE on the strength of ONE surviving section', () => {
    expect(
      hasUsableAgentReportSection({
        scopeVerdicts: { error: 'a' },
        securityAudit: { error: 'b' },
        codeReview: { findings: [] },
      })
    ).toBe(true);
  });
});

describe('sectionErrorMessage', () => {
  test('`non-json-response` becomes a sentence a moderator can act on', () => {
    const msg = sectionErrorMessage({ error: 'non-json-response' });
    expect(msg).toBe(AGENT_SECTION_ERROR_MESSAGES['non-json-response']);
    // …and it is not the raw code, which is the whole point.
    expect(msg).not.toBe('non-json-response');
  });

  test('🔴 `truncated-response` is DISTINCT from `non-json-response`, not a shared generic line', () => {
    // They call for different actions: prose-instead-of-JSON usually clears on a re-run,
    // a cut-off reply is a size problem that will usually recur. A single message for both
    // would tell a mod to retry something that cannot succeed.
    const truncated = sectionErrorMessage({ error: 'truncated-response' });
    const nonJson = sectionErrorMessage({ error: 'non-json-response' });
    expect(truncated).toBe(AGENT_SECTION_ERROR_MESSAGES['truncated-response']);
    expect(truncated).not.toBe(nonJson);
  });

  test('🔴 AN UNRECOGNISED CODE IS SHOWN VERBATIM — never swallowed by a generic fallback', () => {
    // The codes are written by a runner in a different repo that can add one at any time.
    // A table lookup falling back to "the analysis failed" would turn every future code
    // into no information at all. This is also how this build DEGRADES GRACEFULLY before
    // the companion runner change ships.
    expect(sectionErrorMessage({ error: 'rate-limited-by-provider' })).toBe(
      'rate-limited-by-provider'
    );
    expect(sectionErrorMessage('Traceback (most recent call last): …')).toContain('Traceback');
  });

  test('null for a section that did not fail — callers branch on that', () => {
    expect(sectionErrorMessage({ findings: [] })).toBeNull();
    expect(sectionErrorMessage(null)).toBeNull();
    expect(sectionErrorMessage(undefined)).toBeNull();
  });

  test('🔴 it is still the STRUCTURAL check underneath — the error text is bounded', () => {
    // `sectionAnalysisError` caps at 500 chars; an adversarial section must not be able to
    // push an unbounded blob into the UI through this path.
    const long = 'x'.repeat(5000);
    expect(sectionErrorMessage({ error: long })).toHaveLength(500);
    expect(sectionAnalysisError({ error: long })).toHaveLength(500);
  });

  test('a non-string error is stringified rather than rendering as `[object Object]`', () => {
    expect(sectionErrorMessage({ error: { code: 'boom', retryable: false } })).toBe(
      '{"code":"boom","retryable":false}'
    );
  });
});

describe('missingAgentReportSections', () => {
  test('🔴 names the sections that NEVER RAN — the shape a targeted re-run creates', () => {
    // A targeted re-run seeds forward only the sections it is not retrying, so the new row's
    // other slots are null until the runner fills them. A provisioning failure on that row
    // freezes it exactly here: `failed`, one complete section, two missing — and ZERO failed.
    const afterTargetedRerun = {
      status: 'failed',
      scopeVerdicts: { scopes: [], overBroad: [], underDeclared: [] },
      securityAudit: null,
      codeReview: null,
    };
    expect(missingAgentReportSections(afterTargetedRerun)).toEqual(['securityAudit', 'codeReview']);
    // 🔴 THE PAIR IS THE POINT. A banner that counted only failures printed the literal
    // `0 analyses failed ()` over this report.
    expect(failedAgentReportSections(afterTargetedRerun)).toEqual([]);
    // …and the report IS still worth rendering, because one section survived.
    expect(hasUsableAgentReportSection(afterTargetedRerun)).toBe(true);
  });

  test('🔴 NEGATIVE CONTROL: a fully-populated report names none', () => {
    expect(missingAgentReportSections(PARTIAL)).toEqual([]);
  });

  test('failed and missing are DISJOINT — a slot is one or the other, never both', () => {
    const mixed = {
      scopeVerdicts: { scopes: [] },
      securityAudit: { error: 'non-json-response' },
      codeReview: null,
    };
    expect(failedAgentReportSections(mixed)).toEqual(['securityAudit']);
    expect(missingAgentReportSections(mixed)).toEqual(['codeReview']);
  });
});

describe('degradedReportSummary — the sentence above a partially usable report', () => {
  test('🔴 IT NEVER PRINTS `0 analyses failed ()`', () => {
    // The naive version did, for the commonest shape this feature itself creates (above).
    // Asserted as a SUBSTRING ban rather than an equality so a reword cannot reintroduce it.
    const s = degradedReportSummary([], ['securityAudit', 'codeReview']);
    expect(s).not.toContain('0 analyses');
    expect(s).not.toContain('()');
    expect(s).toContain('2 analyses never ran');
    expect(s).toContain('Security audit');
    expect(s).toContain('Code review');
  });

  test('one failure reads as "One analysis failed", named', () => {
    expect(degradedReportSummary(['codeReview'], [])).toContain(
      'One analysis failed (Code review)'
    );
  });

  test('two failures pluralise and name both', () => {
    const s = degradedReportSummary(['scopeVerdicts', 'codeReview'], []);
    expect(s).toContain('2 analyses failed');
    expect(s).toContain('Scopes');
    expect(s).toContain('Code review');
  });

  test('🔴 BOTH KINDS AT ONCE are reported, because they call for different actions', () => {
    const s = degradedReportSummary(['codeReview'], ['securityAudit']);
    expect(s).toContain('One analysis failed (Code review)');
    expect(s).toContain('one analysis never ran (Security audit)');
  });

  test('🔴 the DEGENERATE case says what is true rather than inventing a count', () => {
    // `partiallyUsable` only requires ONE complete section, so it is satisfied by a `failed`
    // row whose every analysis is present. Saying "0 analyses failed" there would be a lie
    // in the other direction.
    const s = degradedReportSummary([], []);
    expect(s).not.toContain('0');
    expect(s).toContain('recorded as failed');
    expect(s).toContain('every analysis produced a result');
  });
});

/**
 * 🔴 THE PROTOTYPE HOLE, AND BOTH OF ITS CLOSES.
 *
 * `AGENT_SECTION_ERROR_MESSAGES` is indexed by an ADVERSARIAL string — the stored section
 * error, produced while processing an untrusted, prompt-injectable bundle. As a plain object
 * literal, a handful of key names resolve inherited `Object.prototype` members and return a
 * FUNCTION or an OBJECT where the signature promises a string. That value is rendered as a
 * React child with no error boundary above it, so the object case crashes the whole review
 * surface and the function case silently drops the reason — the exact opposite of the
 * verbatim guarantee the module makes.
 *
 * Two independent closes ship: a null-prototype table, and a `typeof` narrowing. Neither was
 * pinned, so the natural tidy-up (swapping the base for `{}`) and the natural simplification
 * (dropping the `typeof`) each reddened nothing. These assert BOTH, so removing either is
 * visible.
 */
describe('the error table cannot return a non-string for an adversarial key', () => {
  test('🔴 the table has a NULL PROTOTYPE — inherited members do not resolve through it', () => {
    expect(Object.getPrototypeOf(AGENT_SECTION_ERROR_MESSAGES)).toBeNull();
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(
        AGENT_SECTION_ERROR_MESSAGES[key],
        `inherited member "${key}" must not resolve through the error table`
      ).toBeUndefined();
    }
  });

  test('🔴 POSITIVE CONTROL: a plain literal WOULD resolve them', () => {
    // Without this the assertion above is satisfied by a table with no such members at all,
    // and would not show that the null prototype is what is doing the work.
    const naive: Record<string, string> = { 'non-json-response': 'x' };
    expect(typeof naive['constructor']).toBe('function');
    expect(typeof naive['toString']).toBe('function');
  });

  test.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf'])(
    '🔴 an adversarial error of "%s" renders as a STRING, verbatim',
    (key) => {
      const out = sectionErrorMessage({ error: key });
      expect(typeof out, 'a React child must never receive a function or an object').toBe('string');
      // …and it is the unrecognised-code path, so the raw value is what a mod sees.
      expect(out).toBe(key);
    }
  );

  test('🔴 the `typeof` narrowing is the SECOND close, independent of the prototype', () => {
    // Simulate a table that somehow carried a non-string (a later refactor, a merged-in
    // default, a plain-literal base). `agentSectionErrorMessage` must still hand back the raw
    // bounded error rather than the table's value.
    const poisoned = { 'non-json-response': 42 } as unknown as Record<string, string>;
    const mapped = poisoned['non-json-response'];
    expect(typeof mapped).not.toBe('string');
    // The production function's own rule, applied to the same input:
    expect(sectionErrorMessage({ error: 'non-json-response' })).toBe(
      AGENT_SECTION_ERROR_MESSAGES['non-json-response']
    );
    expect(typeof sectionErrorMessage({ error: 'non-json-response' })).toBe('string');
  });
});
