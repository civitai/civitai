import { describe, expect, it } from 'vitest';
import {
  decisionEnabled,
  decisionReasonFor,
  flagRefId,
  flaggedDecisionEnabled,
  flaggedDecisions,
  flaggedReasonGroups,
  parseKeptIds,
  planDecision,
  planReasonProblem,
  type FlagRef,
} from '../flagged-decision';

describe('flaggedDecisionEnabled', () => {
  it('allows both keys when nobody has appealed', () => {
    for (const source of ['hash', 'redetected', 'text-scan'] as const) {
      expect(flaggedDecisionEnabled({ source, hasPendingAppeal: false })).toEqual([true, true]);
    }
  });

  it('turns keep off but leaves lift on for a hash row under appeal', () => {
    expect(flaggedDecisionEnabled({ source: 'hash', hasPendingAppeal: true })).toEqual([
      false,
      true,
    ]);
  });

  it('turns keep off but leaves lift on for a text-scan row under appeal', () => {
    expect(flaggedDecisionEnabled({ source: 'text-scan', hasPendingAppeal: true })).toEqual([
      false,
      true,
    ]);
  });

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

  it('offers both-flag decisions on keys 1 and 2, then one split per kept label', () => {
    const decisions = flaggedDecisions([minorText, poiText]);
    expect(decisions.map((d) => [d.label, d.keep, d.key])).toEqual([
      ['Confirm both flags', ['minor:text-scan', 'poi:text-scan'], 1],
      ['Revert both', [], 2],
      ['Keep minor, revert real person', ['minor:text-scan'], undefined],
      ['Revert minor, keep real person', ['poi:text-scan'], undefined],
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
    // An open appeal blocks keeping either flag, so only Revert both is left.
    expect([confirm, revert, keepMinor, keepPoi].map((d) => decisionEnabled(both, d))).toEqual([
      false,
      true,
      false,
      false,
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
