import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Job from '~/server/jobs/job';

vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof Job>()),
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { reconcileCollectionCollaboration } from '~/server/jobs/reconcile-collection-collaboration';
import {
  collaborationMemberUserIds,
  reopenLapsedCollections,
} from '~/server/services/collection-collaboration-lapse';

const executeRaw = vi.mocked(dbMock.dbWrite.$executeRaw);

function renderedWrite(callIndex = 0) {
  const [first, ...rest] = executeRaw.mock.calls[callIndex] as unknown[];
  const sql = Array.isArray(first)
    ? Prisma.sql(first as unknown as TemplateStringsArray, ...(rest as Prisma.Sql[]))
    : (first as Prisma.Sql);
  return { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
}

const memberText = collaborationMemberUserIds.sql.replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(0);
});

describe('reopenLapsedCollections', () => {
  it("clears the lapse on the user's own collections only", async () => {
    await reopenLapsedCollections(4527785);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const { text, values } = renderedWrite();
    expect(text).toContain('SET "collaborationDisabledAt" = NULL');
    expect(text).toMatch(/c\."userId" = \?/);
    expect(values).toContain(4527785);
  });

  it('never closes a collection — closing stays with the nightly job', async () => {
    await reopenLapsedCollections(1);

    expect(renderedWrite().text).not.toMatch(/"collaborationDisabledAt" = (?!NULL)/);
  });

  it('reopens only when the owner passes the same member check the nightly job uses', async () => {
    await reopenLapsedCollections(1);
    await reconcileCollectionCollaboration.run({} as never);

    expect(renderedWrite(0).text).toContain(memberText);
    expect(renderedWrite(1).text).toContain(memberText);
  });
});
