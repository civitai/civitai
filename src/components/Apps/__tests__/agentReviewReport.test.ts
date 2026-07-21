import { describe, expect, it } from 'vitest';
import {
  fileLineLabel,
  formatCostUsd,
  parseAgentReport,
} from '~/components/Apps/agentReviewReport';

/**
 * Tolerant-parse contract for the adversarial LLM report columns (the
 * sanitization BOUNDARY). Every field is `.catch()`-wrapped so a single
 * malformed field never throws / blanks the report; unknown keys are stripped;
 * missing sub-objects default to their empty shape.
 */

describe('parseAgentReport — tolerant shaping', () => {
  it('a fully-populated report parses into typed view-models (unknown keys stripped)', () => {
    const v = parseAgentReport({
      codeReview: {
        findings: [{ file: 'a.js', line: 3, severity: 'high', title: 'X', description: 'd', extra: 1 }],
        priorFindingsReconciled: [{ title: 'old', status: 'resolved' }],
        notes: 'n',
        bogusTopKey: true,
      },
      securityAudit: {
        findings: [{ severity: 'low' }],
        manifestUnexpectedKeys: ['weird'],
        iframeSandboxGrants: ['allow-same-origin'],
        promptInjectionAttempts: [{ file: 'r.md', excerpt: 'ignore prev' }],
        notes: 's',
      },
      scopeVerdicts: {
        scopes: [
          {
            declared: 'buzz:read:self',
            used: 'yes',
            justificationAccurate: 'weak',
            sensitive: true,
            evidence: ['a.js:1'],
            notes: 'ok',
          },
        ],
        overBroad: ['user:*'],
        underDeclared: ['models:write'],
      },
      tokenUsage: { promptTokens: 100, completionTokens: 20 },
    });

    expect(v.codeReview.findings).toHaveLength(1);
    // Unknown `extra` key is stripped.
    expect(v.codeReview.findings[0]).not.toHaveProperty('extra');
    expect(v.codeReview.findings[0].severity).toBe('high');
    expect(v.codeReview.priorFindingsReconciled[0].status).toBe('resolved');
    expect(v.securityAudit.manifestUnexpectedKeys).toEqual(['weird']);
    expect(v.securityAudit.iframeSandboxGrants).toEqual(['allow-same-origin']);
    expect(v.securityAudit.promptInjectionAttempts[0].excerpt).toBe('ignore prev');
    expect(v.scopeVerdicts.scopes[0].sensitive).toBe(true);
    expect(v.scopeVerdicts.overBroad).toEqual(['user:*']);
    expect(v.scopeVerdicts.underDeclared).toEqual(['models:write']);
    expect(v.tokenUsage.promptTokens).toBe(100);
  });

  it('missing / null columns default to empty shapes (never throw)', () => {
    const v = parseAgentReport({});
    expect(v.codeReview.findings).toEqual([]);
    expect(v.codeReview.priorFindingsReconciled).toEqual([]);
    expect(v.securityAudit.findings).toEqual([]);
    expect(v.securityAudit.manifestUnexpectedKeys).toEqual([]);
    expect(v.securityAudit.iframeSandboxGrants).toEqual([]);
    expect(v.securityAudit.promptInjectionAttempts).toEqual([]);
    expect(v.scopeVerdicts.scopes).toEqual([]);
    expect(v.scopeVerdicts.overBroad).toEqual([]);
    expect(v.scopeVerdicts.underDeclared).toEqual([]);

    const vn = parseAgentReport({
      codeReview: null,
      securityAudit: null,
      scopeVerdicts: null,
      tokenUsage: null,
    });
    expect(vn.codeReview.findings).toEqual([]);
    expect(vn.scopeVerdicts.scopes).toEqual([]);
  });

  it('wrong-typed fields are treated as absent, not thrown', () => {
    const v = parseAgentReport({
      // findings is a string, severity is an object, evidence is a number
      codeReview: { findings: 'not-an-array', notes: 42 },
      securityAudit: { findings: [{ severity: { nested: true }, title: 5 }], iframeSandboxGrants: 'x' },
      scopeVerdicts: { scopes: [{ declared: 'ok', evidence: 7, sensitive: 'yes' }] },
      tokenUsage: { promptTokens: 'lots' },
    });
    expect(v.codeReview.findings).toEqual([]);
    expect(v.codeReview.notes).toBeUndefined();
    // The finding survives with only the well-typed absence; bad fields → undefined.
    expect(v.securityAudit.findings[0].severity).toBeUndefined();
    expect(v.securityAudit.findings[0].title).toBeUndefined();
    expect(v.securityAudit.iframeSandboxGrants).toEqual([]);
    expect(v.scopeVerdicts.scopes[0].declared).toBe('ok');
    expect(v.scopeVerdicts.scopes[0].evidence).toEqual([]);
    // 'yes' is not a boolean → sensitive falls back to undefined (falsy).
    expect(v.scopeVerdicts.scopes[0].sensitive).toBeUndefined();
    expect(v.tokenUsage.promptTokens).toBeUndefined();
  });

  it('parseAgentReport does NOT transform string content (render layer sanitizes)', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const v = parseAgentReport({
      codeReview: { findings: [{ description: payload }] },
      securityAudit: {},
      scopeVerdicts: {},
    });
    // The parser preserves the raw string verbatim — it guarantees SHAPE, not
    // content escaping (the panel renders it as inert text, the real guard).
    expect(v.codeReview.findings[0].description).toBe(payload);
  });
});

describe('formatCostUsd', () => {
  it('formats numbers, numeric strings, and Decimal-like objects', () => {
    expect(formatCostUsd(0.01)).toBe('$0.0100');
    expect(formatCostUsd('0.012345')).toBe('$0.0123');
    expect(formatCostUsd({ toString: () => '0.5' })).toBe('$0.5000');
  });
  it('returns null for null/undefined/NaN', () => {
    expect(formatCostUsd(null)).toBeNull();
    expect(formatCostUsd(undefined)).toBeNull();
    expect(formatCostUsd('not-a-number')).toBeNull();
  });
});

describe('fileLineLabel', () => {
  it('builds file:line, tolerates missing parts', () => {
    expect(fileLineLabel('a.js', 3)).toBe('a.js:3');
    expect(fileLineLabel('a.js', '10')).toBe('a.js:10');
    expect(fileLineLabel('a.js')).toBe('a.js');
    expect(fileLineLabel('a.js', '')).toBe('a.js');
    expect(fileLineLabel(undefined, 3)).toBeNull();
  });
});
