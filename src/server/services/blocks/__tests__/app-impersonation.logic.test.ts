import { describe, expect, it } from 'vitest';
import {
  impersonationSkeleton,
  listingNameMatchFindings,
  impersonationFingerprint,
  mergeImpersonationIntoSecurityAudit,
  parseModelJudgement,
  protectedTermFindings,
  stripImpersonationRecord,
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

  it.each([
    // Greek capitals fold to the Latin capital they look like — BEFORE lowercasing, which would
    // turn Η into η (n), Ν into ν (v) and Υ into υ (u).
    ['ΗΕLLΟ', 'HELLO'],
    ['ΝΟVΑ', 'NOVA'],
    ['ΥΑΚ', 'YAK'],
    ['ΜΑΖΕ', 'MAZE'],
    ['ΒΙΤΡΚΧ', 'BITPKX'],
    // Cyrillic capitals.
    ['АВЕКМНОРСТХ', 'ABEKMHOPCTX'],
    // Lower-case look-alikes outside the Latin block.
    ['zoı', 'zoi'],
    ['ɑpp', 'app'],
    ['ɡame', 'game'],
    ['һello', 'hello'],
    ['ԍame', 'game'],
    ['bօt', 'bot'],
  ])('%s reads as %s', (lookalike, latin) => {
    expect(impersonationSkeleton(lookalike)).toBe(impersonationSkeleton(latin));
  });

  it('a different name stays different', () => {
    expect(impersonationSkeleton('Zorblex Studio')).not.toBe(
      impersonationSkeleton('Zorbit Studio')
    );
  });
});

describe('listingNameMatchFindings (deterministic)', () => {
  it("🔴 another author's app with the same name (after normalisation) fires, at medium", () => {
    const findings = listingNameMatchFindings(
      subject({ name: 'Z0rblex Studio', slug: 'my-studio' }),
      [other({ name: 'Zorblex Studio', slug: 'zorblex-studio' }), other({ name: 'Unrelated' })]
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
      listingNameMatchFindings(subject({ name: 'Sketch Helper' }), [
        other({ name: 'Drawing Assistant' }),
      ])
    ).toEqual([]);
  });

  it('a structural fork link to the matched app records it at low (not a flag)', () => {
    const byListing = listingNameMatchFindings(
      subject({ name: 'Zorblex Studio', forkOfListingId: 'apl_parent' }),
      [other({ id: 'apl_parent', name: 'Zorblex Studio' })]
    );
    expect(byListing.map((f) => f.severity)).toEqual(['low']);
    const byBlock = listingNameMatchFindings(
      subject({ name: 'Zorblex Studio', forkOfAppBlockId: 'ab_parent' }),
      [other({ appBlockId: 'ab_parent', name: 'Zorblex Studio' })]
    );
    expect(byBlock.map((f) => f.severity)).toEqual(['low']);
  });

  it('a fork link to a DIFFERENT app does not lower the match', () => {
    const findings = listingNameMatchFindings(
      subject({ name: 'Zorblex Studio', forkOfListingId: 'apl_someone_else' }),
      [other({ id: 'apl_parent', name: 'Zorblex Studio' })]
    );
    expect(findings.map((f) => f.severity)).toEqual(['medium']);
  });

  it('🔴 only an IDENTICAL normalised name matches — one character apart does not', () => {
    const o = [other({ name: 'Zorblex Studio' })];
    expect(listingNameMatchFindings(subject({ name: 'Zorblez Studio' }), o)).toEqual([]);
    expect(listingNameMatchFindings(subject({ name: 'Zorblex Studios' }), o)).toEqual([]);
    expect(listingNameMatchFindings(subject({ name: 'zorblex-STUDIO' }), o)).toHaveLength(1);
    // A caller that still passes a near-miss bound gets no fuzzy match: there is no such bound.
    const withStrayBound = listingNameMatchFindings as unknown as (...args: unknown[]) => unknown[];
    expect(withStrayBound(subject({ name: 'Zorblez Studio' }), o, 1)).toEqual([]);
  });

  it("the submission's own slug is never compared with itself", () => {
    expect(
      listingNameMatchFindings(subject({ name: 'Zorblex Studio', slug: 'zorblex-studio' }), [
        other({ name: 'Zorblex Studio', slug: 'zorblex-studio' }),
      ])
    ).toEqual([]);
  });
});

describe('protectedTermFindings (deterministic)', () => {
  const terms = ['Zorblex', 'Quaddle Labs'];

  it('🔴 a protected term in the NAME fires at medium, look-alike spellings included', () => {
    const findings = protectedTermFindings(subject({ name: 'Official Z0rbl3x Tools' }), terms);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', check: 'protected-term' });
    expect(findings[0].evidence).toContain('term: Zorblex');
  });

  it('a protected term in the SLUG fires', () => {
    expect(
      protectedTermFindings(subject({ name: 'Tools', slug: 'quaddlelabs-tools' }), terms)
    ).toHaveLength(1);
  });

  it('a mention only in the description does not fire (saying it works WITH a brand is fine)', () => {
    expect(
      protectedTermFindings(
        subject({ name: 'Sketch Helper', description: 'Works with your Zorblex account.' }),
        terms
      )
    ).toEqual([]);
  });

  it('🔴 a listing that calls itself unofficial STILL fires at medium (no declaration exemption)', () => {
    const findings = protectedTermFindings(
      subject({
        name: 'Zorblex Helper',
        tagline: 'An unofficial fan project',
        description: 'Not affiliated with Zorblex Inc.',
      }),
      terms
    );
    expect(findings.map((f) => f.severity)).toEqual(['medium']);
  });

  it('no terms → no findings (the service treats that as a check that did not run)', () => {
    expect(protectedTermFindings(subject({ name: 'Zorblex Helper' }), [])).toEqual([]);
  });
});

describe('parseModelJudgement — malformed model output is an ERROR, never a clear check', () => {
  it('normalises severities (unknown → medium), keeps untitled findings with a placeholder, caps the count', () => {
    const r = parseModelJudgement({
      findings: [
        { severity: 'HIGH', title: 'Uses the Zorblex logo', detail: 'Icon is the Zorblex mark' },
        { severity: 'catastrophic', title: 'Odd severity' },
        { severity: 'low', title: '' },
        { severity: 'medium' },
        ...Array.from({ length: 10 }, (_, i) => ({ severity: 'low', title: `extra ${i}` })),
      ],
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.findings.map((f) => f.title)).toEqual([
      'Uses the Zorblex logo',
      'Odd severity',
      'Untitled impersonation finding',
      'Untitled impersonation finding',
      'extra 0',
    ]);
    expect(r.findings.map((f) => f.severity)).toEqual(['high', 'medium', 'low', 'medium', 'low']);
    expect(r.findings.every((f) => f.check === 'model-judgement')).toBe(true);
  });

  it('an empty findings array is a clean answer', () => {
    expect(parseModelJudgement({ findings: [] })).toEqual({ ok: true, findings: [] });
  });

  it.each([
    [null],
    ['a string'],
    [{}],
    [{ findings: 'none' }],
    [{ findings: { title: 'x' } }],
    [{ findings: ['not an object'] }],
    [{ findings: [null] }],
  ])('🔴 %o → not ok (the check is incomplete)', (judgement) => {
    const r = parseModelJudgement(judgement);
    expect(r.ok).toBe(false);
  });
});

describe('impersonationFingerprint — what the check looked at', () => {
  const base = {
    name: 'Sketch Helper',
    slug: 'sketch-helper',
    tagline: 'Draw',
    description: 'Draws things',
    iconId: 1,
    coverId: 2,
  };
  it('is stable for the same listing and moves when ANY identity field moves', () => {
    const fp = impersonationFingerprint(base);
    expect(impersonationFingerprint({ ...base })).toBe(fp);
    for (const change of [
      { name: 'Sketch Helper 2' },
      { slug: 'other' },
      { tagline: 'Paint' },
      { description: 'Paints things' },
      { iconId: 3 },
      { coverId: null },
    ]) {
      expect(impersonationFingerprint({ ...base, ...change }), JSON.stringify(change)).not.toBe(fp);
    }
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
  const finding = protectedTermFindings(subject({ name: 'Zorblex' }), ['Zorblex'])[0];

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
