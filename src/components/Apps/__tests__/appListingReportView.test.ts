import { describe, expect, it } from 'vitest';

import {
  APP_LISTING_REPORT_REASON_OPTIONS,
  getReportReasonLabel,
  isReportReason,
  reportErrorMessage,
} from '~/components/Apps/appListingReportView';
import { APP_LISTING_REPORT_REASONS } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * W13 P3b — pure report VIEW MODEL (the blocking gate for the reason picker; the
 * browser-mode modal test is report-only). Pins: the option list matches the
 * schema tuple exactly (no drift), every label is non-empty, and the error mapper
 * gives the friendly duplicate-report copy on CONFLICT.
 */

describe('APP_LISTING_REPORT_REASON_OPTIONS', () => {
  it('has exactly one option per schema reason, in the schema order', () => {
    expect(APP_LISTING_REPORT_REASON_OPTIONS.map((o) => o.value)).toEqual([
      ...APP_LISTING_REPORT_REASONS,
    ]);
  });

  it('every option has a non-empty human label distinct from the raw value', () => {
    for (const opt of APP_LISTING_REPORT_REASON_OPTIONS) {
      expect(opt.label.trim().length).toBeGreaterThan(0);
      expect(opt.label).not.toBe(opt.value);
    }
  });

  it('has no duplicate values or labels', () => {
    const values = APP_LISTING_REPORT_REASON_OPTIONS.map((o) => o.value);
    const labels = APP_LISTING_REPORT_REASON_OPTIONS.map((o) => o.label);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('getReportReasonLabel', () => {
  it('returns the human label for a known reason', () => {
    expect(getReportReasonLabel('spam')).toBe('Spam');
  });

  it('falls back to the raw value for an unknown reason', () => {
    expect(getReportReasonLabel('mystery')).toBe('mystery');
  });
});

describe('isReportReason', () => {
  it('accepts every schema reason and rejects anything else', () => {
    for (const opt of APP_LISTING_REPORT_REASON_OPTIONS) {
      expect(isReportReason(opt.value)).toBe(true);
    }
    expect(isReportReason('bogus')).toBe(false);
    expect(isReportReason('')).toBe(false);
  });
});

describe('reportErrorMessage', () => {
  it('maps CONFLICT to the friendly "already reported" copy', () => {
    expect(reportErrorMessage({ data: { code: 'CONFLICT' }, message: 'dup' })).toContain(
      'already reported'
    );
  });

  it('surfaces the server message for a BAD_REQUEST / NOT_FOUND', () => {
    expect(
      reportErrorMessage({ data: { code: 'BAD_REQUEST' }, message: 'only an approved listing can be reported' })
    ).toContain('approved listing');
    expect(reportErrorMessage({ data: { code: 'NOT_FOUND' }, message: 'listing not found' })).toContain(
      'not found'
    );
  });

  it('gives a generic fallback for an unknown / internal error (never a raw leak)', () => {
    const msg = reportErrorMessage({ data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'ECONNREFUSED' });
    expect(msg).not.toContain('ECONNREFUSED');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('handles a null/undefined error', () => {
    expect(reportErrorMessage(null).length).toBeGreaterThan(0);
    expect(reportErrorMessage(undefined).length).toBeGreaterThan(0);
  });
});
