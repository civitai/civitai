import { describe, expect, it } from 'vitest';
import type { ProposedLabel } from '../compose';
import type { Answers } from '../questions';
import {
  cohenKappa,
  combineOutcome,
  disagreementRows,
  goldLabel,
  signalsArmPromoted,
  summarise,
  thresholdAnswers,
  wilsonLower,
  type ArmSummary,
  type HumanLabel,
  type Prediction,
  type ReportItem,
  type Thresholds,
} from '../report';

const T: Thresholds = { minorPresent: 0.5, sexualLevel: 0.5, violence: 0.5, schoolSetting: 0.5 };

const nonSexualMinor: Answers = {
  minorPresent: 'appears_minor',
  sexualLevel: 'none',
  violence: 'threat_or_aiming',
  schoolSetting: 'other_setting',
};

function predict(
  itemId: string,
  arm: Prediction['arm'],
  ans: Answers,
  confidence = 0.9
): Prediction {
  const answers: Prediction['answers'] = {};
  for (const [k, v] of Object.entries(ans))
    answers[k as keyof Answers] = { choice: v, confidence, abstained: false };
  return { itemId, arm, answers };
}

const human = (itemId: string, labelerId: number, answers: Answers): HumanLabel => ({
  itemId,
  labelerId,
  answers,
});

describe('thresholdAnswers', () => {
  it('a low-confidence answer becomes cannot_tell, so no label is proposed from it', () => {
    const p = predict('1', 'image', nonSexualMinor);
    p.answers.violence = { choice: 'threat_or_aiming', confidence: 0.49, abstained: false };
    expect(thresholdAnswers(p, T)?.violence).toBe('cannot_tell');
  });

  it('an abstained answer becomes cannot_tell whatever its confidence', () => {
    const p = predict('1', 'image', nonSexualMinor);
    p.answers.minorPresent = { choice: 'appears_minor', confidence: 0.99, abstained: true };
    expect(thresholdAnswers(p, T)?.minorPresent).toBe('cannot_tell');
  });
});

describe('combineOutcome is monotone', () => {
  const proposals: (ProposedLabel | null)[] = [
    null,
    'minor_sexual',
    'minor_sexual_school',
    'minor_violence',
    'minor_no_mature_context',
    'gore',
    'no_minor',
  ];
  it('a removed item stays removed whatever the model proposes', () => {
    for (const p of proposals) expect(combineOutcome('removed', p)).toBe('removed');
  });
  it('a kept item can only gain a hold, never anything looser', () => {
    for (const p of proposals) expect(['kept', 'hold']).toContain(combineOutcome('kept', p));
    expect(combineOutcome('kept', 'minor_sexual')).toBe('hold');
    expect(combineOutcome('kept', 'no_minor')).toBe('kept');
  });
});

describe('goldLabel', () => {
  it('needs both labelers to compose the same label', () => {
    expect(goldLabel([human('1', 1, nonSexualMinor), human('1', 2, nonSexualMinor)])).toBe(
      'minor_violence'
    );
    expect(
      goldLabel([
        human('1', 1, nonSexualMinor),
        human('1', 2, { ...nonSexualMinor, sexualLevel: 'partial_nudity' }),
      ])
    ).toBeNull();
    expect(goldLabel([human('1', 1, nonSexualMinor)])).toBeNull();
  });
});

describe('statistics', () => {
  it('kappa: perfect agreement is 1, chance-level agreement is 0', () => {
    expect(
      cohenKappa([
        ['a', 'a'],
        ['b', 'b'],
      ])
    ).toBe(1);
    expect(
      cohenKappa([
        ['a', 'a'],
        ['a', 'b'],
        ['b', 'a'],
        ['b', 'b'],
      ])
    ).toBe(0);
  });
  it('wilson lower bound sits below the point estimate and is null with no data', () => {
    expect(wilsonLower(8, 10)).toBeCloseTo(0.49, 2);
    expect(wilsonLower(0, 0)).toBeNull();
  });
});

describe('disagreementRows and summarise', () => {
  const items: ReportItem[] = [
    {
      itemId: '1',
      imageId: 101,
      stratum: 'removed',
      bucket: 'animatedMinorNsfw',
      appealStatus: 'Approved',
    },
    { itemId: '2', imageId: 102, stratum: 'not_removed', bucket: null, appealStatus: null },
  ];
  const labels = [
    human('1', 1, nonSexualMinor),
    human('1', 2, nonSexualMinor),
    human('2', 1, { ...nonSexualMinor, sexualLevel: 'explicit_nudity' }),
    human('2', 2, { ...nonSexualMinor, sexualLevel: 'explicit_nudity' }),
  ];
  const preds = [
    predict('1', 'image', nonSexualMinor),
    predict('2', 'image', { ...nonSexualMinor, sexualLevel: 'explicit_nudity' }),
  ];

  it('measures disagreement in both directions', () => {
    const rows = disagreementRows(items, labels, preds, T);
    expect(rows.map((r) => [r.itemId, r.disagreement, r.combined])).toEqual([
      ['1', 'not_sexual', 'removed'],
      ['2', 'flags_minor_sexual', 'hold'],
    ]);
    expect(rows.every((r) => r.proposalMatchesGold === true)).toBe(true);
  });

  it('counts a disagreeing removal against its approved appeal', () => {
    const [s] = summarise(items, labels, preds, T);
    expect(s.removedDisagreeing).toEqual({ not_sexual: 1 });
    expect(s.notRemovedFlagging).toEqual({ flags_minor_sexual: 1 });
    expect(s.disagreeingRight).toBe(2);
    expect(s.appeals).toEqual({
      disagreeApproved: 1,
      disagreeResolved: 1,
      agreeApproved: 0,
      agreeResolved: 0,
    });
    expect(s.minorRecall).toEqual({ hit: 2, of: 2 });
  });
});

describe('signalsArmPromoted', () => {
  const arm = (right: number, of: number, hit: number, minorOf: number): ArmSummary => ({
    arm: 'image',
    predictions: of,
    covered: of,
    removedDisagreeing: {},
    notRemovedFlagging: {},
    disagreeingWithGold: of,
    disagreeingRight: right,
    disagreeingRightLower: null,
    minorRecall: { hit, of: minorOf },
    appeals: { disagreeApproved: 0, disagreeResolved: 0, agreeApproved: 0, agreeResolved: 0 },
  });

  it('promotes when more precise with no loss of minor recall', () => {
    expect(signalsArmPromoted(arm(8, 10, 9, 10), arm(9, 10, 9, 10))).toBe(true);
  });

  it('rejects a more precise arm that misses even one more minor', () => {
    expect(signalsArmPromoted(arm(5, 10, 10, 10), arm(10, 10, 9, 10))).toBe(false);
  });

  it('rejects an arm that is only as precise', () => {
    expect(signalsArmPromoted(arm(8, 10, 9, 10), arm(8, 10, 10, 10))).toBe(false);
  });
});
