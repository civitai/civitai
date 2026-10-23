import { describe, expect, it } from 'vitest';
import {
  BATCH_DECISIONS,
  DECISION_KEY_ORDER,
  decisionButtons,
  decisionOutcome,
  expectedStatus,
  holdDecisionEnabled,
  modelRuleHoldFilterParams,
  modelStatusLabel,
  DEFAULT_MODEL_RULE_HOLD_FILTERS,
} from '../model-rule-holds';

describe('decisionButtons', () => {
  it('words Review holds as unpublishing and Auto holds as keeping down / republishing', () => {
    const review = Object.fromEntries(decisionButtons('shadow').map((b) => [b.decision, b.label]));
    expect(review.confirm).toBe('Confirm — unpublish');
    expect(review.dismiss_not_subject).toBe('Dismiss — not this subject');
    expect(review.dismiss_allowed).toBe('Dismiss — allowed use');
    const auto = Object.fromEntries(decisionButtons('active').map((b) => [b.decision, b.label]));
    expect(auto.confirm).toBe('Confirm — keep down');
    expect(auto.dismiss_not_subject).toBe('Dismiss — republish (not this subject)');
    expect(auto.dismiss_allowed).toBe('Dismiss — republish (allowed use)');
  });

  it('lists the decisions in key order', () => {
    expect(decisionButtons('shadow').map((b) => b.decision)).toEqual([...DECISION_KEY_ORDER]);
  });
});

describe('holdDecisionEnabled', () => {
  const pending = { status: 'Pending', userId: 7 };
  it('enables strike only with the grant and a known owner', () => {
    expect(holdDecisionEnabled(pending, { canStrike: true })).toEqual([true, true, true, true]);
    expect(holdDecisionEnabled(pending, { canStrike: false })).toEqual([true, false, true, true]);
    expect(holdDecisionEnabled({ ...pending, userId: null }, { canStrike: true })).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });
  it('offers nothing once decided', () => {
    expect(holdDecisionEnabled({ status: 'Confirmed', userId: 7 }, { canStrike: true })).toEqual(
      []
    );
  });
});

describe('batch decisions', () => {
  it('never include a strike', () => {
    expect(BATCH_DECISIONS).not.toContain('confirm_strike');
  });
});

describe('expectedStatus / decisionOutcome', () => {
  it('maps confirms to Confirmed and dismissals to Dismissed', () => {
    expect(expectedStatus('confirm')).toBe('Confirmed');
    expect(expectedStatus('confirm_strike')).toBe('Confirmed');
    expect(expectedStatus('dismiss_not_subject')).toBe('Dismissed');
    expect(expectedStatus('dismiss_allowed')).toBe('Dismissed');
  });
  it('names what happened to the model per mode', () => {
    expect(decisionOutcome('confirm', 'shadow')).toBe('Model unpublished');
    expect(decisionOutcome('confirm', 'active')).toBe('Model kept down');
    expect(decisionOutcome('dismiss_allowed', 'active')).toBe('Dismissed — model republished');
    expect(decisionOutcome('dismiss_allowed', 'shadow')).toBe('Dismissed');
  });
});

describe('modelRuleHoldFilterParams', () => {
  it('omits defaults', () => {
    expect(modelRuleHoldFilterParams(DEFAULT_MODEL_RULE_HOLD_FILTERS)).toEqual({});
    expect(
      modelRuleHoldFilterParams({ status: 'confirmed', mode: 'auto', sort: 'newest', rule: 4 })
    ).toEqual({ status: 'confirmed', mode: 'auto', sort: 'newest', rule: '4' });
  });
});

describe('modelStatusLabel', () => {
  it('reads a stored status in words', () => {
    expect(modelStatusLabel('UnpublishedViolation')).toBe('Unpublished violation');
    expect(modelStatusLabel('Draft')).toBe('Draft');
  });
});
