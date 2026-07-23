import { describe, expect, it } from 'vitest';
import {
  fileLineLabel,
  findingBody,
  formatCostUsd,
  parseAgentReport,
  sectionAnalysisError,
  severityBreakdown,
  severityRank,
  sortFindingsBySeverity,
  type AgentFinding,
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

describe('findingBody', () => {
  it('prefers the richer `detail` over legacy `description`', () => {
    expect(findingBody({ evidence: [], detail: 'D', description: 'legacy' })).toBe('D');
    expect(findingBody({ evidence: [], description: 'legacy' })).toBe('legacy');
    expect(findingBody({ evidence: [] })).toBeUndefined();
  });
});

describe('parseAgentReport — richer finding fields', () => {
  it('captures category / detail / evidence / suggestion / diffStatus / confidence', () => {
    const v = parseAgentReport({
      codeReview: {
        findings: [
          {
            file: 'a.js',
            line: 3,
            severity: 'high',
            category: 'security',
            title: 'X',
            detail: 'the detail',
            evidence: ['a.js:3', 'b.js:9'],
            suggestion: 'do Y',
            diffStatus: 'added',
          },
        ],
      },
      securityAudit: {
        findings: [{ severity: 'critical', title: 'Z', evidence: ['c.js:1'], confidence: 'high' }],
      },
    });
    const f = v.codeReview.findings[0];
    expect(f.category).toBe('security');
    expect(f.detail).toBe('the detail');
    expect(f.evidence).toEqual(['a.js:3', 'b.js:9']);
    expect(f.suggestion).toBe('do Y');
    expect(f.diffStatus).toBe('added');
    expect(v.securityAudit.findings[0].confidence).toBe('high');
    // A wrong-typed evidence array falls back to [] (never throws).
    const bad = parseAgentReport({ codeReview: { findings: [{ title: 'T', evidence: 'nope' }] } });
    expect(bad.codeReview.findings[0].evidence).toEqual([]);
  });
});

describe('severityRank + sortFindingsBySeverity', () => {
  it('ranks by descending risk; unknown severities sort last', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('medium'));
    expect(severityRank('low')).toBeLessThan(severityRank('info'));
    expect(severityRank('bogus')).toBeGreaterThan(severityRank('info'));
    expect(severityRank(undefined)).toBeGreaterThan(severityRank('info'));
  });

  it('sorts critical → info, stable within a bucket, without mutating input', () => {
    const input: AgentFinding[] = [
      { evidence: [], severity: 'low', title: 'L' },
      { evidence: [], severity: 'critical', title: 'C' },
      { evidence: [], severity: 'medium', title: 'M1' },
      { evidence: [], severity: 'medium', title: 'M2' },
      { evidence: [], title: 'unknown' },
    ];
    const out = sortFindingsBySeverity(input);
    expect(out.map((f) => f.title)).toEqual(['C', 'M1', 'M2', 'L', 'unknown']);
    // Input untouched.
    expect(input[0].title).toBe('L');
  });
});

describe('severityBreakdown', () => {
  it('buckets counts (medium + moderate collapse; unknown → other)', () => {
    const b = severityBreakdown([
      { evidence: [], severity: 'critical' },
      { evidence: [], severity: 'high' },
      { evidence: [], severity: 'medium' },
      { evidence: [], severity: 'moderate' },
      { evidence: [], severity: 'low' },
      { evidence: [], severity: 'info' },
      { evidence: [], severity: 'weird' },
      { evidence: [] },
    ]);
    expect(b).toEqual({ total: 8, critical: 1, high: 1, medium: 2, low: 1, info: 1, other: 2 });
  });
});

describe('sectionAnalysisError', () => {
  it('detects an { error } object or a bare string; null for well-formed/empty', () => {
    expect(sectionAnalysisError({ error: 'boom' })).toBe('boom');
    expect(sectionAnalysisError({ error: { code: 'X' } })).toContain('X');
    expect(sectionAnalysisError('runner crashed')).toBe('runner crashed');
    expect(sectionAnalysisError({ findings: [] })).toBeNull();
    expect(sectionAnalysisError({})).toBeNull();
    expect(sectionAnalysisError(null)).toBeNull();
    expect(sectionAnalysisError(undefined)).toBeNull();
    expect(sectionAnalysisError({ error: null })).toBeNull();
    expect(sectionAnalysisError('   ')).toBeNull();
  });
});
