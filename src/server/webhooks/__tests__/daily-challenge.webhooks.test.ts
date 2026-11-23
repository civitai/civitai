import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
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
});
