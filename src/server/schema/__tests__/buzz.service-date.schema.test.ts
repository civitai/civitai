import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buzzServiceDate,
  getBuzzTransactionResponse,
  getTransactionsReportResultSchema,
  getUserBuzzTransactionsResponse,
} from '~/server/schema/buzz.schema';
import { getHistorySchema } from '~/server/schema/games/new-order.schema';

const ORIGINAL_TZ = process.env.TZ;

/**
 * 🔴 Every assertion here is an identity on a UTC host, which is what CI runs. Without the pin,
 * reverting to `z.coerce.date()` passes. Chicago is behind UTC and Tokyo ahead; the reward
 * cap-release path (`releaseCapForRefusedAward`) misfires on hosts AHEAD of UTC, where a payment
 * shortly after 00:00 UTC would parse into the previous day.
 *
 * `delete` on restore: `process.env.TZ = undefined` stores the string "undefined".
 */
describe.each(['America/Chicago', 'Asia/Tokyo'])(
  'buzz service timestamps parse as UTC in %s',
  (tz) => {
    beforeAll(() => {
      process.env.TZ = tz;
    });
    afterAll(() => {
      if (ORIGINAL_TZ === undefined) delete process.env.TZ;
      else process.env.TZ = ORIGINAL_TZ;
    });

    it(`is running in ${tz}`, () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
      expect(new Date('2026-08-31T00:00:00').getTimezoneOffset()).not.toBe(0);
    });

    it('reads an offset-less timestamp as UTC', () => {
      expect(buzzServiceDate.parse('2026-08-31T00:05:00').toISOString()).toBe(
        '2026-08-31T00:05:00.000Z'
      );
      expect(buzzServiceDate.parse('2026-08-31T00:05:00.123').toISOString()).toBe(
        '2026-08-31T00:05:00.123Z'
      );
      expect(buzzServiceDate.parse('2026-08-31 00:05:00').toISOString()).toBe(
        '2026-08-31T00:05:00.000Z'
      );
    });

    it('keeps an explicit offset', () => {
      expect(buzzServiceDate.parse('2026-08-31T00:05:00Z').toISOString()).toBe(
        '2026-08-31T00:05:00.000Z'
      );
      expect(buzzServiceDate.parse('2026-08-31T00:05:00+02:00').toISOString()).toBe(
        '2026-08-30T22:05:00.000Z'
      );
    });

    it('passes a Date through unchanged', () => {
      const instant = new Date('2026-08-31T00:05:00.000Z');
      expect(buzzServiceDate.parse(instant).getTime()).toBe(instant.getTime());
    });

    it('puts a transaction paid just after 00:00 UTC on that UTC day', () => {
      const { date } = getBuzzTransactionResponse.parse({
        date: '2026-08-31T00:05:00',
        type: 'Reward',
        fromAccountId: 0,
        toAccountId: 1,
        fromAccountType: 'User',
        toAccountType: 'User',
        amount: 10,
      });
      expect(date.getTime()).toBe(Date.UTC(2026, 7, 31, 0, 5));
      expect(date.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 7, 31));
    });

    // Fed back as the next page's start (nowpayments-credit.service): a shifted cursor skips or
    // repeats transactions.
    it('reads an offset-less pagination cursor as UTC', () => {
      const { cursor } = getUserBuzzTransactionsResponse.parse({
        cursor: '2026-08-31T00:05:00',
        transactions: [],
      });
      expect(cursor?.toISOString()).toBe('2026-08-31T00:05:00.000Z');
    });

    it('reads a ClickHouse keyset cursor as UTC (new-order history)', () => {
      const { cursor } = getHistorySchema.parse({
        cursor: { createdAt: '2026-08-31 00:05:00', imageId: 1 },
      });
      expect(cursor?.createdAt.toISOString()).toBe('2026-08-31T00:05:00.000Z');
    });

    it('labels a report bucket with the service timestamp verbatim', () => {
      const [bucket] = getTransactionsReportResultSchema.parse([
        {
          date: '2026-08-31T00:00:00',
          start: '2026-08-31T00:00:00',
          end: '2026-09-01T00:00:00',
          accounts: [],
        },
      ]);
      expect(bucket).toMatchObject({
        date: '2026-08-31T00:00:00',
        start: '2026-08-31T00:00:00',
        end: '2026-09-01T00:00:00',
      });
    });
  }
);
