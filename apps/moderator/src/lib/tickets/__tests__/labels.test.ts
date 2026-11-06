import { describe, expect, it } from 'vitest';
import {
  bountyTypeLabel,
  formatMinorUnits,
  humanize,
  intervalLabel,
  payoutStatusLabel,
  reportStatusLabel,
  restrictionStatusLabel,
  subscriptionBadge,
  trainingStatusLabel,
} from '../labels';

describe('subscriptionBadge', () => {
  it('reads live statuses as neutral, failed payments as alarms and ended ones as quiet', () => {
    expect(['active', 'trialing'].map(subscriptionBadge)).toEqual(['secondary', 'secondary']);
    expect(['past_due', 'unpaid', 'incomplete'].map(subscriptionBadge)).toEqual([
      'destructive',
      'destructive',
      'destructive',
    ]);
    expect(['canceled', 'incomplete_expired'].map(subscriptionBadge)).toEqual([
      'outline',
      'outline',
    ]);
  });

  it('does not alarm on a status it does not know', () => {
    expect(subscriptionBadge('paused')).toBe('outline');
  });
});

describe('humanize', () => {
  it('spaces PascalCase, snake_case and kebab-case into a sentence', () => {
    expect(humanize('FailedFee')).toBe('Failed fee');
    expect(humanize('past_due')).toBe('Past due');
    expect(humanize('DataSetCaption')).toBe('Data set caption');
  });
});

describe('status labels', () => {
  it('never show the raw enum text of a known value', () => {
    expect(
      ['FailedFee', 'InternalValue', 'FraudReview', 'ExternallyResolved'].map(payoutStatusLabel)
    ).toEqual(['Failed fee', 'Internal value', 'Fraud review', 'Resolved externally']);
    expect(reportStatusLabel('Unactioned')).toBe('Dismissed');
    expect(trainingStatusLabel('InReview')).toBe('In review');
    expect(restrictionStatusLabel('AccountDeleted')).toBe('Account deleted');
    expect(bountyTypeLabel('LoraCreation')).toBe('LoRA');
  });

  it('humanise a value added to an enum after the map was written', () => {
    expect(payoutStatusLabel('SomeNewState')).toBe('Some new state');
    expect(bountyTypeLabel('AudioCreation')).toBe('Audio creation');
  });
});

describe('intervalLabel', () => {
  it('names each interval, and leaves an unknown one as stored', () => {
    expect(['day', 'week', 'month', 'year'].map(intervalLabel)).toEqual([
      'daily',
      'weekly',
      'monthly',
      'yearly',
    ]);
    expect(intervalLabel('quarter')).toBe('quarter');
  });
});

describe('formatMinorUnits', () => {
  it("divides by the currency's own minor units", () => {
    expect(formatMinorUnits(999, 'usd')).toBe('$9.99');
    expect(formatMinorUnits(999, 'JPY')).toBe('¥999');
    expect(formatMinorUnits(1500, 'KWD')).toContain('1.500');
  });

  it('falls back to the code for a currency it does not know, or none', () => {
    expect(formatMinorUnits(999, 'zzzz')).toBe('9.99 ZZZZ');
    expect(formatMinorUnits(999, null)).toBe('9.99');
  });
});
