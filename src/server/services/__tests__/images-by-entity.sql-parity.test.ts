import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The SQL `getImagesByEntity` sends, per viewer, pinned so a change to its visibility rules is a
 * deliberate snapshot edit.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { getImagesByEntity } from '../image.service';

const sent: Prisma.Sql[] = [];
beforeAll(() => {
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sent.push(Prisma.sql(strings, ...values));
      return [];
    }
  );
});

async function sqlFor(viewer: {
  userId?: number;
  isModerator?: boolean;
  seesReportListed?: boolean;
}) {
  sent.length = 0;
  await getImagesByEntity({ ids: [1, 2], type: 'BountyEntry', seesReportListed: false, ...viewer });
  expect(sent).toHaveLength(1);
  return { sql: sent[0].sql.replace(/\s+/g, ' ').trim(), values: sent[0].values };
}

describe('getImagesByEntity SQL', () => {
  it('for an anonymous viewer', async () => {
    expect(await sqlFor({})).toMatchSnapshot();
  });
  it('for a signed-in viewer', async () => {
    expect(await sqlFor({ userId: 20 })).toMatchSnapshot();
  });
  it('for a moderator', async () => {
    expect(await sqlFor({ userId: 30, isModerator: true })).toMatchSnapshot();
  });
  it('for a moderator who sees report-listed images', async () => {
    expect(
      await sqlFor({ userId: 30, isModerator: true, seesReportListed: true })
    ).toMatchSnapshot();
  });
});
