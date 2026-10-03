import { describe, expect, test } from 'vitest';
import {
  AGENT_REPORT_SECTIONS,
  AGENT_REPORT_SECTION_LABELS,
  AGENT_SECTION_ERROR_MESSAGES,
  agentReportSectionStatuses,
  failedAgentReportSections,
  hasUsableAgentReportSection,
  isAgentReportSection,
  sectionAnalysisError,
  sectionErrorMessage,
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

  test('a BARE STRING in a structured slot is a runner log dump, i.e. `failed`', () => {
    expect(agentReportSectionStatuses({ securityAudit: 'Traceback…' }).securityAudit).toBe(
      'failed'
    );
    // …but an empty string carries no information and is not a failure claim.
    expect(agentReportSectionStatuses({ securityAudit: '   ' }).securityAudit).toBe('complete');
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
