import { describe, expect, it } from 'vitest';
import {
  decisionEnabled,
  decisionReasonFor,
  decisionReasonList,
  flagRefId,
  flaggedDecisionEnabled,
  flaggedDecisions,
  flaggedReasonGroups,
  appealRuling,
  needsReviewDecisions,
  parseKeptIds,
  planDecision,
  planReasonProblem,
  routesThroughAppeal,
  type FlagRef,
} from '../flagged-decision';

describe('flaggedDecisionEnabled', () => {
  it('allows both keys when nobody has appealed', () => {
    for (const source of ['hash', 'redetected', 'text-scan'] as const) {
      expect(flaggedDecisionEnabled({ source, hasPendingAppeal: false })).toEqual([true, true]);
    }
  });

  it.each(['hash', 'text-scan'] as const)(
    'leaves both keys on for a %s row under appeal: the ruling resolves the appeal',
    (source) => {
      expect(flaggedDecisionEnabled({ source, hasPendingAppeal: true })).toEqual([true, true]);
    }
  );

  it.each(['hash', 'text-scan'] as const)(
    'locks both keys for a %s row under appeal when the viewer lacks the Appeals tab',
    (source) => {
      const row = { source, hasPendingAppeal: true, canRuleAppeals: false };
      expect(flaggedDecisionEnabled(row)).toEqual([false, false]);
      expect(flaggedDecisionEnabled({ ...row, hasPendingAppeal: false })).toEqual([true, true]);
    }
  );

  it('locks both keys for a re-detection under appeal', () => {
    expect(flaggedDecisionEnabled({ source: 'redetected', hasPendingAppeal: true })).toEqual([
      false,
      false,
    ]);
  });
});

const minorText: FlagRef = { label: 'minor', source: 'text-scan', textHash: 'h-1' };
const poiText: FlagRef = { label: 'poi', source: 'text-scan', textHash: 'h-1' };
const minorHash: FlagRef = { label: 'minor', source: 'hash', textHash: null };
const minorHeld: FlagRef = { label: 'minor', source: 'redetected', textHash: 'h-2' };

describe('flaggedDecisions', () => {
  it('offers confirm and revert for one flag', () => {
    expect(flaggedDecisions([minorText]).map((d) => [d.label, d.keep])).toEqual([
      ['Confirm minor flag', ['minor:text-scan']],
      ['Revert flag', []],
    ]);
  });

  it('offers both-flag decisions first, then one split per kept label', () => {
    const decisions = flaggedDecisions([minorText, poiText]);
    expect(decisions.map((d) => [d.label, d.keep])).toEqual([
      ['Confirm both flags', ['minor:text-scan', 'poi:text-scan']],
      ['Revert both', []],
      ['Keep minor, revert real person', ['minor:text-scan']],
      ['Revert minor, keep real person', ['poi:text-scan']],
    ]);
  });

  it('offers no split when two flags share a label', () => {
    expect(flaggedDecisions([minorHash, minorHeld]).map((d) => d.label)).toEqual([
      'Confirm both flags',
      'Revert both',
    ]);
  });
});

describe('decisionEnabled', () => {
  const both = [
    { ...minorHash, hasPendingAppeal: true },
    { ...poiText, hasPendingAppeal: true },
  ];
  it('allows a decision only when every flag allows its part of it', () => {
    const [confirm, revert, keepMinor, keepPoi] = flaggedDecisions(both);
    expect([confirm, revert, keepMinor, keepPoi].map((d) => decisionEnabled(both, d))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('blocks every decision that touches a re-detection under appeal', () => {
    const flags = [{ ...minorHeld, hasPendingAppeal: true }];
    expect(flaggedDecisions(flags).map((d) => decisionEnabled(flags, d))).toEqual([false, false]);
  });
});

describe('parseKeptIds', () => {
  const flags = [minorText, poiText];
  it('reads the kept flags of the pressed button', () => {
    expect(parseKeptIds('poi:text-scan', flags)).toEqual(['poi:text-scan']);
    expect(parseKeptIds('', flags)).toEqual([]);
  });
  it('refuses a flag the form does not carry', () => {
    expect(parseKeptIds('poi:hash', flags)).toBeNull();
    expect(parseKeptIds(null, flags)).toBeNull();
  });
});

describe('the reason a decision records', () => {
  it('needs a reason that fits every label it rules', () => {
    const revertBoth = planDecision([minorText, poiText], []);
    // "Not a minor" explains the minor flag only, so it cannot revert both.
    expect(planReasonProblem(revertBoth, 'Revert both', 'not-a-minor', '')).toMatch(
      /does not apply/
    );
    expect(planReasonProblem(revertBoth, 'Revert both', 'terms-misread', '')).toBeNull();
    expect(planReasonProblem(revertBoth, 'Revert both', 'detection-correct', '')).toMatch(
      /not a reason to revert both/
    );
  });

  it('records the picked reason on the reverted flag and detection-correct on the kept one in a split', () => {
    const split = planDecision([minorText, poiText], ['minor:text-scan']);
    expect(
      planReasonProblem(split, 'Keep minor, revert real person', 'not-a-real-person', '')
    ).toBeNull();
    expect(planReasonProblem(split, 'Keep minor, revert real person', 'not-a-minor', '')).toMatch(
      /does not apply/
    );
    const [kept, reverted] = split;
    expect(decisionReasonFor(split, kept, 'not-a-real-person')).toBe('detection-correct');
    expect(decisionReasonFor(split, reverted, 'not-a-real-person')).toBe('not-a-real-person');
  });

  it('needs no reason for hash flags, which record none', () => {
    expect(planReasonProblem(planDecision([minorHash], []), 'Revert flag', '', '')).toBeNull();
    const mixed = planDecision([minorHash, poiText], [flagRefId(minorHash)]);
    // Keeping the hash flag records nothing, and the reverted text-scan flag needs its reason.
    expect(planReasonProblem(mixed, 'Keep minor, revert real person', '', '')).toMatch(
      /Pick a reason/
    );
  });

  it('wants a note with Other', () => {
    const confirm = planDecision([minorText], ['minor:text-scan']);
    expect(planReasonProblem(confirm, 'Confirm minor flag', 'other', '')).toMatch(/note/);
    expect(planReasonProblem(confirm, 'Confirm minor flag', 'other', 'because')).toBeNull();
  });
});

describe('flaggedReasonGroups', () => {
  const labels = { keep: 'Confirm', revert: 'Revert' };
  it('lists each reason once, covering every reasoned label', () => {
    const groups = flaggedReasonGroups([minorText, poiText, minorHash], labels)!;
    expect(groups.map((g) => [g.label, g.reasons.map((r) => r.value)])).toEqual([
      ['Confirm', ['detection-correct', 'other']],
      ['Revert', ['not-a-minor', 'terms-misread', 'other', 'not-a-real-person']],
    ]);
  });
  it('is null when only hash flags are ruled', () => {
    expect(flaggedReasonGroups([minorHash], labels)).toBeNull();
  });
});

describe('needsReviewDecisions', () => {
  const held = (label: 'minor' | 'poi'): FlagRef => ({
    label,
    source: 'redetected',
    textHash: 'h',
  });
  const match: FlagRef = { label: 'minor', source: 'file-match', textHash: null };

  it('flags or does not flag a single held detection', () => {
    expect(needsReviewDecisions([held('poi')])).toEqual([
      { label: 'Flag as real person', keep: ['poi:redetected'] },
      { label: "Don't flag", keep: [] },
    ]);
  });

  it('flags a file match as minor or dismisses it', () => {
    expect(needsReviewDecisions([match])).toEqual([
      { label: 'Flag as minor', keep: ['minor:file-match'] },
      { label: 'Dismiss match', keep: [] },
    ]);
  });

  it('names both labels, and offers one per-label split, when two detections differ', () => {
    expect(needsReviewDecisions([held('minor'), held('poi')])).toEqual([
      {
        label: 'Flag as minor and real person',
        keep: ['minor:redetected', 'poi:redetected'],
      },
      { label: "Don't flag", keep: [] },
      { label: 'Flag as minor only', keep: ['minor:redetected'] },
      { label: 'Flag as real person only', keep: ['poi:redetected'] },
    ]);
  });

  it('offers no split when a held minor detection and a file match name the same label', () => {
    expect(needsReviewDecisions([held('minor'), match])).toEqual([
      { label: 'Flag as minor', keep: ['minor:redetected', 'minor:file-match'] },
      { label: "Don't flag", keep: [] },
    ]);
  });
});

describe('file matches', () => {
  it('stay open to both keys whatever the appeal state: the main app owns that check', () => {
    expect(flaggedDecisionEnabled({ source: 'file-match', hasPendingAppeal: true })).toEqual([
      true,
      true,
    ]);
  });

  it('record no reason, so a match alone offers no reason select', () => {
    expect(
      flaggedReasonGroups([{ label: 'minor', source: 'file-match', textHash: null }], {
        keep: 'Flag',
        revert: 'Dismiss',
      })
    ).toBeNull();
  });
});

describe('decisionReasonList', () => {
  const groups = flaggedReasonGroups([minorText, poiText], { keep: 'Confirm', revert: 'Revert' })!;
  const [confirm, revert, split] = flaggedDecisions([minorText, poiText]);

  it('offers the keep reasons for a decision that keeps every flag', () => {
    expect(decisionReasonList(groups, confirm, 2)).toBe(groups[0].reasons);
  });

  it('offers the revert reasons for a revert and for a split, whose reason explains its revert', () => {
    expect(decisionReasonList(groups, revert, 2)).toBe(groups[1].reasons);
    expect(decisionReasonList(groups, split, 2)).toBe(groups[1].reasons);
  });
});

describe('an Auto-flagged row with a pending appeal', () => {
  const plan = (keep: string[], flags: FlagRef[] = [minorText, poiText]) =>
    planDecision(flags, keep);

  it('routes through the appeal only for hash and text-scan flags', () => {
    expect(routesThroughAppeal([minorHash, poiText], true)).toBe(true);
    expect(routesThroughAppeal([minorHash, poiText], false)).toBe(false);
    expect(routesThroughAppeal([minorHeld], true)).toBe(false);
  });

  it('keeping every flag rejects the appeal, reverting every flag approves it', () => {
    expect(appealRuling(plan(['minor:text-scan', 'poi:text-scan']))).toEqual({
      verdict: 'Rejected',
      lifted: [],
      perLabel: null,
    });
    expect(appealRuling(plan([]))).toEqual({
      verdict: 'Approved',
      lifted: ['minor', 'poi'],
      perLabel: null,
    });
  });

  it('a split rules each label and approves the appeal for the reverted ones', () => {
    expect(appealRuling(plan(['minor:text-scan']))).toEqual({
      verdict: 'Approved',
      lifted: ['poi'],
      perLabel: { minor: 'uphold', poi: 'overturn' },
    });
  });

  it('refuses a label that is both kept and reverted', () => {
    expect(appealRuling(plan(['minor:hash'], [minorHash, minorText]))).toEqual({
      error: expect.stringMatching(/same label/),
    });
  });

  it('checks the reason against the appeal verdict, not the flag-review lists', () => {
    const keepAll = plan(['minor:text-scan', 'poi:text-scan']);
    expect(planReasonProblem(keepAll, 'Confirm both flags', 'flag-confirmed', '', true)).toBeNull();
    expect(planReasonProblem(keepAll, 'Confirm both flags', 'detection-correct', '', true)).toMatch(
      /not a reason/
    );
    expect(planReasonProblem(plan([]), 'Revert both', '', '', true)).toMatch(/Pick a reason/);
    // A hash flag records no reason outside an appeal; the appeal always needs one.
    expect(planReasonProblem(plan(['minor:hash'], [minorHash]), 'Confirm', '', '', true)).toMatch(
      /Pick a reason/
    );
  });

  it('offers the appeal reasons for keep and revert', () => {
    const groups = flaggedReasonGroups([minorHash], { keep: 'Confirm', revert: 'Revert' }, true)!;
    expect(groups[0].reasons.map((r) => r.value)).toEqual(['flag-confirmed', 'other']);
    expect(groups[1].reasons.map((r) => r.value)).toContain('not-a-minor');
  });
});
