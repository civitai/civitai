import { describe, expect, it } from 'vitest';

import {
  APP_LISTING_REPORT_REASONS,
  APP_LISTING_REPORT_STATUSES,
  OFFSITE_REPORT_DETAILS_MAX,
  listListingReportsSchema,
  reportListingSchema,
} from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * W13 P3b — off-site moderation INPUT validation + the reason/status tuples.
 *
 * Pins: the reason enum, the details bound, the mod-queue limit cap (≤50), AND
 * that the schema tuples equal the migration CHECK sets (a drift would let the
 * proc write a value the DB's `app_listing_reports_*_check` CHECK rejects — 23514).
 */

describe('APP_LISTING_REPORT_REASONS — matches the migration CHECK set', () => {
  it('is exactly the 6 documented reasons, in order', () => {
    expect([...APP_LISTING_REPORT_REASONS]).toEqual([
      'impersonation',
      'phishing-malware',
      'broken',
      'inappropriate',
      'spam',
      'other',
    ]);
  });
});

describe('APP_LISTING_REPORT_STATUSES — matches the migration CHECK set', () => {
  it('is exactly pending|resolved|dismissed', () => {
    expect([...APP_LISTING_REPORT_STATUSES]).toEqual(['pending', 'resolved', 'dismissed']);
  });
});

describe('reportListingSchema', () => {
  const base = { appListingId: 'apl_01HZZ', reason: 'spam' as const };

  it('accepts a minimal valid report (no details)', () => {
    const parsed = reportListingSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it('accepts every enum reason', () => {
    for (const reason of APP_LISTING_REPORT_REASONS) {
      expect(reportListingSchema.safeParse({ ...base, reason }).success).toBe(true);
    }
  });

  it('rejects a reason not in the enum', () => {
    expect(reportListingSchema.safeParse({ ...base, reason: 'nonsense' }).success).toBe(false);
  });

  it('requires a non-empty appListingId', () => {
    expect(reportListingSchema.safeParse({ ...base, appListingId: '' }).success).toBe(false);
  });

  it('accepts details up to the bound and rejects over it', () => {
    const ok = { ...base, details: 'x'.repeat(OFFSITE_REPORT_DETAILS_MAX) };
    const tooLong = { ...base, details: 'x'.repeat(OFFSITE_REPORT_DETAILS_MAX + 1) };
    expect(reportListingSchema.safeParse(ok).success).toBe(true);
    expect(reportListingSchema.safeParse(tooLong).success).toBe(false);
  });

  it('has NO reporter field — the reporter is caller-forced (mass-assignment guard)', () => {
    const parsed = reportListingSchema.parse({
      ...base,
      // A malicious extra field is stripped by zod's default object parse.
      reporterUserId: 999,
    } as unknown as { appListingId: string; reason: 'spam' });
    expect((parsed as Record<string, unknown>).reporterUserId).toBeUndefined();
  });
});

describe('listListingReportsSchema', () => {
  it('accepts an empty query (defaults handled in the service)', () => {
    expect(listListingReportsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an optional status filter', () => {
    expect(listListingReportsSchema.safeParse({ status: 'pending' }).success).toBe(true);
    expect(listListingReportsSchema.safeParse({ status: 'resolved' }).success).toBe(true);
  });

  it('rejects a status not in the enum', () => {
    expect(listListingReportsSchema.safeParse({ status: 'open' }).success).toBe(false);
  });

  it('caps limit at 50', () => {
    expect(listListingReportsSchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(listListingReportsSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(listListingReportsSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});
