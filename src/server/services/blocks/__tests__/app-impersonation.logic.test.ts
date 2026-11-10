import { describe, expect, it } from 'vitest';
import {
  boundedEditDistance,
  impersonationSkeleton,
  listingNameMatchFindings,
  mergeImpersonationIntoSecurityAudit,
  modelJudgementFindings,
  protectedTermFindings,
  stripImpersonationRecord,
  verifiedDeclarationQuote,
  type ImpersonationCheckRecord,
  type ImpersonationSubject,
  type OtherListing,
} from '~/server/services/blocks/app-impersonation.logic';
import {
  agentSectionFailureMessage,
  isAgentSectionFailureMarker,
} from '~/shared/constants/agent-review-section.constants';

/**
 * The impersonation check's deterministic rules. The brand names here are invented
 * ("Zorblex", "Quaddle"): the real protected-term list is moderator-managed data and never
 * lives in this repo.
 */

const subject = (over: Partial<ImpersonationSubject> = {}): ImpersonationSubject => ({
  name: 'Sketch Helper',
  slug: 'sketch-helper',
  tagline: null,
  description: null,
  forkOfAppBlockId: null,
  forkOfListingId: null,
  ...over,
});

const other = (over: Partial<OtherListing> & { name: string }): OtherListing => ({
  id: 'apl_other',
  slug: 'other-app',
  appBlockId: 'ab_other',
  ...over,
});

describe('impersonationSkeleton — names that render alike compare equal', () => {
  it.each([
    ['Zorblex Studio', 'zorbiexstudio'],
    ['ZORBLEX-studio', 'zorbiexstudio'],
    ['Z0rb1ex Stud10', 'zorbiexstudio'],
    ['Zörblèx Studio', 'zorbiexstudio'],
    // Fullwidth letters fold through NFKD.
    ['Ｚｏｒｂｌｅｘ Studio', 'zorbiexstudio'],
    // Cyrillic о and е in place of the Latin letters.
    ['Zоrblеx Studio', 'zorbiexstudio'],
    // `rn` reads as `m`, `vv` as `w`.
    ['Quaddle Rnaker', 'quaddiemaker'],
    ['Quaddle VVorks', 'quaddieworks'],
  ])('%s → %s', (input, expected) => {
    expect(impersonationSkeleton(input)).toBe(expected);
  });

  it('a different name stays different', () => {
    expect(impersonationSkeleton('Zorblex Studio')).not.toBe(
      impersonationSkeleton('Zorbit Studio')
    );
  });
});

describe('boundedEditDistance', () => {
  it('counts edits and gives up past the bound', () => {
    expect(boundedEditDistance('zorbiex', 'zorbiex', 1)).toBe(0);
    expect(boundedEditDistance('zorbiex', 'zorbiez', 1)).toBe(1);
    expect(boundedEditDistance('zorbiex', 'zorbiezz', 2)).toBe(2);
    expect(boundedEditDistance('zorbiex', 'abcdefg', 2)).toBe(3);
    expect(boundedEditDistance('ab', 'abcdef', 1)).toBe(2);
  });
});

describe('listingNameMatchFindings (deterministic)', () => {
  it("🔴 another author's app with the same name (after normalisation) fires, at medium", () => {
    const findings = listingNameMatchFindings(
      subject({ name: 'Z0rblex Studio', slug: 'my-studio' }),
      [other({ name: 'Zorblex Studio', slug: 'zorblex-studio' }), other({ name: 'Unrelated' })],
      0
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'medium',
      category: 'impersonation',
      check: 'listing-name-match',
    });
    expect(findings[0].evidence).toContain('matched: zorblex-studio');
  });

  it('similar functionality under a different name does not fire', () => {
    expect(
      listingNameMatchFindings(
        subject({ name: 'Sketch Helper' }),
        [other({ name: 'Drawing Assistant' })],
        1
      )
    ).toEqual([]);
  });

  it('a structural fork link to the matched app records it at low (not a flag)', () => {
    const byListing = listingNameMatchFindings(
      subject({ name: 'Zorblex Studio', forkOfListingId: 'apl_parent' }),
      [other({ id: 'apl_parent', name: 'Zorblex Studio' })],
      0
    );
    expect(byListing.map((f) => f.severity)).toEqual(['low']);
    const byBlock = listingNameMatchFindings(
      subject({ name: 'Zorblex Studio', forkOfAppBlockId: 'ab_parent' }),
      [other({ appBlockId: 'ab_parent', name: 'Zorblex Studio' })],
      0
    );
    expect(byBlock.map((f) => f.severity)).toEqual(['low']);
  });

  it('a fork link to a DIFFERENT app does not lower the match', () => {
    const findings = listingNameMatchFindings(
      subject({ name: 'Zorblex Studio', forkOfListingId: 'apl_someone_else' }),
      [other({ id: 'apl_parent', name: 'Zorblex Studio' })],
      0
    );
    expect(findings.map((f) => f.severity)).toEqual(['medium']);
  });

  it('the near-miss bound comes from config: 0 matches only identical skeletons, 1 also one edit away', () => {
    const s = subject({ name: 'Zorblez Studio' });
    const o = [other({ name: 'Zorblex Studio' })];
    expect(listingNameMatchFindings(s, o, 0)).toEqual([]);
    expect(listingNameMatchFindings(s, o, 1)).toHaveLength(1);
  });

  it('short names only ever match exactly, whatever the bound', () => {
    expect(listingNameMatchFindings(subject({ name: 'Abc' }), [other({ name: 'Abd' })], 1)).toEqual(
      []
    );
    expect(
      listingNameMatchFindings(subject({ name: 'Abc' }), [other({ name: 'A-B-C' })], 1)
    ).toHaveLength(1);
  });

  it("the submission's own slug is never compared with itself", () => {
    expect(
      listingNameMatchFindings(
        subject({ name: 'Zorblex Studio', slug: 'zorblex-studio' }),
        [other({ name: 'Zorblex Studio', slug: 'zorblex-studio' })],
        0
      )
    ).toEqual([]);
  });
});

describe('protectedTermFindings (deterministic)', () => {
  const terms = ['Zorblex', 'Quaddle Labs'];

  it('🔴 a protected term in the NAME fires at medium, look-alike spellings included', () => {
    const findings = protectedTermFindings(
      subject({ name: 'Official Z0rbl3x Tools' }),
      terms,
      null
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', check: 'protected-term' });
    expect(findings[0].evidence).toContain('term: Zorblex');
  });

  it('a protected term in the SLUG fires', () => {
    expect(
      protectedTermFindings(subject({ name: 'Tools', slug: 'quaddlelabs-tools' }), terms, null)
    ).toHaveLength(1);
  });

  it('a mention only in the description does not fire (saying it works WITH a brand is fine)', () => {
    expect(
      protectedTermFindings(
        subject({ name: 'Sketch Helper', description: 'Works with your Zorblex account.' }),
        terms,
        null
      )
    ).toEqual([]);
  });

  it('an honest declaration lowers the hit to low', () => {
    const findings = protectedTermFindings(
      subject({ name: 'Zorblex Helper' }),
      terms,
      'An unofficial fan project'
    );
    expect(findings.map((f) => f.severity)).toEqual(['low']);
  });

  it('no terms → no findings (the service treats that as a check that did not run)', () => {
    expect(protectedTermFindings(subject({ name: 'Zorblex Helper' }), [], null)).toEqual([]);
  });
});

describe('verifiedDeclarationQuote — the model cannot invent a declaration', () => {
  const s = subject({
    name: 'Zorblex Helper',
    description: 'A fan project.   Not affiliated with   Zorblex Inc.',
  });

  it('a quote really in the listing is kept (whitespace and case do not matter)', () => {
    expect(verifiedDeclarationQuote(s, 'not affiliated with zorblex inc')).toBe(
      'not affiliated with zorblex inc'
    );
  });

  it('🔴 a quote the listing does not contain is dropped', () => {
    expect(verifiedDeclarationQuote(s, 'This is an unofficial app')).toBeNull();
  });

  it('too short, or not a string, is dropped', () => {
    expect(verifiedDeclarationQuote(s, 'fan')).toBeNull();
    expect(verifiedDeclarationQuote(s, null)).toBeNull();
    expect(verifiedDeclarationQuote(s, { quote: 'A fan project' })).toBeNull();
  });
});

describe('modelJudgementFindings', () => {
  it('normalises severities (unknown → medium), drops untitled entries, caps the count', () => {
    const findings = modelJudgementFindings({
      findings: [
        { severity: 'HIGH', title: 'Uses the Zorblex logo', detail: 'Icon is the Zorblex mark' },
        { severity: 'catastrophic', title: 'Odd severity' },
        { severity: 'low', title: '' },
        'not an object',
        ...Array.from({ length: 10 }, (_, i) => ({ severity: 'low', title: `extra ${i}` })),
      ],
    });
    expect(findings).toHaveLength(5);
    expect(findings.map((f) => f.title)).toEqual([
      'Uses the Zorblex logo',
      'Odd severity',
      'extra 0',
      'extra 1',
      'extra 2',
    ]);
    expect(findings.map((f) => f.severity)).toEqual(['high', 'medium', 'low', 'low', 'low']);
    expect(findings.every((f) => f.check === 'model-judgement')).toBe(true);
  });

  it('a malformed answer yields nothing', () => {
    expect(modelJudgementFindings(null)).toEqual([]);
    expect(modelJudgementFindings({ findings: 'none' })).toEqual([]);
  });
});

describe('security-audit storage', () => {
  const record: ImpersonationCheckRecord = {
    status: 'complete',
    ranAt: '2026-11-10T00:00:00.000Z',
    checks: {
      'listing-name-match': 'clear',
      'protected-term': 'clear',
      'model-judgement': 'clear',
    },
  };
  const finding = protectedTermFindings(subject({ name: 'Zorblex' }), ['Zorblex'], null)[0];

  it('🔴 a runner-supplied impersonationCheck is stripped (only civitai writes it)', () => {
    expect(
      stripImpersonationRecord({ findings: [], impersonationCheck: { status: 'complete' } })
    ).toEqual({ findings: [] });
    expect(stripImpersonationRecord('dump')).toBe('dump');
    expect(stripImpersonationRecord(null)).toBeNull();
  });

  it("keeps the agent's findings, replaces an earlier run's impersonation findings", () => {
    const agentFinding = { severity: 'low', title: 'console.log left in' };
    const stale = { ...finding, title: 'stale' };
    const merged = mergeImpersonationIntoSecurityAudit(
      { findings: [agentFinding, stale], notes: 'n' },
      [finding],
      record,
      agentSectionFailureMessage
    );
    expect(merged).toEqual({
      findings: [agentFinding, finding],
      notes: 'n',
      impersonationCheck: record,
    });
  });

  it('an agent finding that merely says "impersonation" without a check id is kept', () => {
    const agentOwn = { severity: 'medium', category: 'impersonation', title: 'agent saw it too' };
    const merged = mergeImpersonationIntoSecurityAudit(
      { findings: [agentOwn] },
      [],
      record,
      agentSectionFailureMessage
    );
    expect(merged.findings).toEqual([agentOwn]);
  });

  it.each([null, 'Traceback: runner crashed', ['x']])(
    'a non-object slot (%o) becomes an { error } slot that still reads as a FAILED analysis',
    (slot) => {
      const merged = mergeImpersonationIntoSecurityAudit(
        slot,
        [finding],
        record,
        agentSectionFailureMessage
      );
      expect(isAgentSectionFailureMarker(merged)).toBe(true);
      expect(merged.findings).toEqual([finding]);
      expect(merged.impersonationCheck).toEqual(record);
    }
  );

  it('an { error } slot stays a failure marker after the merge', () => {
    const merged = mergeImpersonationIntoSecurityAudit(
      { error: 'non-json-response' },
      [],
      record,
      agentSectionFailureMessage
    );
    expect(agentSectionFailureMessage(merged)).toBe('non-json-response');
  });
});
