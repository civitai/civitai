import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  reportListedImageSql,
  SIGNED_OUT_REPORT_LISTED,
} from '~/server/services/report-listed-visibility';
import { dailyChallengeWebhooks } from '~/server/webhooks/daily-challenge.webhooks';

describe('daily challenge webhooks', () => {
  it.each(['daily-challenge-complete', 'daily-challenge-start', 'new-daily-challenge'] as const)(
    '%s follows the article availability rule',
    async (event) => {
      const issued: string[] = [];
      const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        issued.push(Prisma.sql(strings, ...(values as never[])).text);
        return [];
      });
      await dailyChallengeWebhooks[event].getData({
        lastSent: new Date(0),
        prisma: { $queryRaw },
      } as never);
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatch(/AND a\.availability != 'Private'\s+AND a\.metadata->>'status'/);
    }
  );

  it.each(['daily-challenge-complete', 'daily-challenge-start', 'new-daily-challenge'] as const)(
    '🔴 %s sends no cover listed on a report',
    async (event) => {
      const issued: string[] = [];
      const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        issued.push(Prisma.sql(strings, ...(values as never[])).text);
        return [];
      });
      await dailyChallengeWebhooks[event].getData({
        lastSent: new Date(0),
        prisma: { $queryRaw },
      } as never);
      // The cover subquery ends with the signed-out report-listed predicate, exactly.
      const term = reportListedImageSql(SIGNED_OUT_REPORT_LISTED).text;
      expect(issued[0]).toContain(`AND ${term}) as "coverUrl"`);
    }
  );
});
