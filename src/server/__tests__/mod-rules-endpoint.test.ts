import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { bustImageModRulesCache } = vi.hoisted(() => ({
  bustImageModRulesCache: vi.fn(async () => undefined),
}));

// The wrapper's token check has its own suite; this one is about which rules the handler may touch.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
  handleEndpointError: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ bustImageModRulesCache }));

const { default: handler } = (await import('~/pages/api/mod/mod-rules')) as unknown as {
  default: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
};

const call = async (req: Partial<NextApiRequest>) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await handler(req as NextApiRequest, res as unknown as NextApiResponse);
  return {
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0],
  };
};
const wordRule = {
  type: 'or',
  rules: [{ type: 'content', target: ['prompt'], match: '/(?:\\b|\\s)Word(?:\\b|\\s)/gmi' }],
};
const propertyRule = {
  type: 'and',
  rules: [wordRule, { type: 'property', condition: '$.width > 400' }],
};
const update = {
  method: 'POST',
  body: { id: 12, userId: 1, action: 'Block', entityType: 'Image', definition: wordRule },
};
const create = { method: 'POST', body: { ...update.body, id: undefined, reason: 'r' } };

const before = {
  definition: { type: 'content', target: ['prompt'], match: 'old' },
  enabled: true,
  action: 'Block',
  reason: 'was',
  createdById: 5,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const after = { definition: wordRule, enabled: false, action: 'Block', reason: 'was' };

// Records whether each write ran inside the transaction callback.
let inTransaction = false;
const writesInTransaction: string[] = [];
const track = (name: string) => () => {
  if (inTransaction) writesInTransaction.push(name);
};

beforeEach(() => {
  vi.clearAllMocks();
  inTransaction = false;
  writesInTransaction.length = 0;
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    inTransaction = true;
    try {
      return await fn(dbMock.dbWrite);
    } finally {
      inTransaction = false;
    }
  });
  dbMock.dbWrite.moderationRule.findFirst.mockResolvedValue(before);
  dbMock.dbWrite.moderationRule.updateMany.mockImplementation(async () => {
    track('rule.updateMany')();
    return { count: 1 };
  });
  dbMock.dbWrite.moderationRule.findFirstOrThrow.mockResolvedValue(after);
  dbMock.dbWrite.moderationRule.create.mockImplementation(async ({ data }) => {
    track('rule.create')();
    return {
      id: 77,
      definition: data.definition,
      enabled: true,
      action: data.action,
      reason: data.reason,
    };
  });
  dbMock.dbWrite.moderationRuleVersion.findFirst.mockResolvedValue({ id: 1 });
  dbMock.dbWrite.moderationRuleVersion.create.mockImplementation(async () => {
    track('version.create')();
    return {};
  });
  dbMock.dbWrite.moderationRuleVersion.createMany.mockImplementation(async () => {
    track('version.createMany')();
    return { count: 1 };
  });
});

const versionRows = () => [
  ...dbMock.dbWrite.moderationRuleVersion.create.mock.calls.map(([a]) => a.data),
  ...dbMock.dbWrite.moderationRuleVersion.createMany.mock.calls.flatMap(([a]) => a.data),
];

describe('/api/mod/mod-rules rule definitions', () => {
  it('refuses to create a rule containing a property condition', async () => {
    const { status } = await call({
      ...create,
      body: { ...create.body, definition: propertyRule },
    });

    expect(status).toBe(400);
    expect(dbMock.dbWrite.moderationRule.create).not.toHaveBeenCalled();
    expect(versionRows()).toEqual([]);
  });

  it('refuses to update a rule to a property condition', async () => {
    const { status } = await call({
      ...update,
      body: { ...update.body, definition: propertyRule },
    });

    expect(status).toBe(400);
    expect(dbMock.dbWrite.moderationRule.updateMany).not.toHaveBeenCalled();
    expect(versionRows()).toEqual([]);
  });
});

describe('/api/mod/mod-rules history', () => {
  it('records the created rule as its first version, in the same transaction', async () => {
    const { status } = await call(create);

    expect(status).toBe(200);
    expect(versionRows()).toEqual([
      {
        ruleId: 77,
        definition: wordRule,
        enabled: true,
        action: 'Block',
        reason: 'r',
        createdById: 1,
      },
    ]);
    expect(writesInTransaction).toEqual(['rule.create', 'version.create']);
  });

  it('records the rule as it stands after a partial update, not the patch', async () => {
    const { status } = await call({ method: 'POST', body: { id: 12, userId: 3, enabled: false } });

    expect(status).toBe(200);
    expect(versionRows()).toEqual([{ ruleId: 12, ...after, createdById: 3 }]);
    expect(writesInTransaction).toEqual(['rule.updateMany', 'version.createMany']);
  });

  it('records the prior state first when the rule has no history yet', async () => {
    dbMock.dbWrite.moderationRuleVersion.findFirst.mockResolvedValue(null);

    await call(update);

    const { updatedAt, ...prior } = before;
    expect(versionRows()).toEqual([
      { ruleId: 12, ...prior, createdAt: updatedAt },
      { ruleId: 12, ...after, createdById: 1 },
    ]);
  });
});

describe('/api/mod/mod-rules', () => {
  it('updates an Image rule', async () => {
    const { status } = await call(update);

    expect(status).toBe(200);
    expect(dbMock.dbWrite.moderationRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 12, entityType: 'Image' } })
    );
    expect(bustImageModRulesCache).toHaveBeenCalledTimes(1);
  });

  it('answers 404 and writes nothing for a Model rule id', async () => {
    // The Image-scoped where matches no Model row, so the update reports none changed.
    dbMock.dbWrite.moderationRule.updateMany.mockResolvedValue({ count: 0 });

    const { status } = await call({ ...update, body: { ...update.body, id: 99 } });

    expect(status).toBe(404);
    expect(dbMock.dbWrite.moderationRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 99, entityType: 'Image' } })
    );
    expect(bustImageModRulesCache).not.toHaveBeenCalled();
  });

  it('refuses to create a rule for another entity type', async () => {
    const { status } = await call({
      ...update,
      body: { ...update.body, id: undefined, entityType: 'Model' },
    });

    expect(status).toBe(400);
    expect(dbMock.dbWrite.moderationRule.create).not.toHaveBeenCalled();
  });

  it('answers 404 and deletes nothing for a Model rule id', async () => {
    dbMock.dbWrite.moderationRule.deleteMany.mockResolvedValue({ count: 0 });

    const { status } = await call({ method: 'DELETE', query: { id: '99' } });

    expect(status).toBe(404);
    expect(dbMock.dbWrite.moderationRule.deleteMany).toHaveBeenCalledWith({
      where: { id: 99, entityType: 'Image' },
    });
    expect(bustImageModRulesCache).not.toHaveBeenCalled();
  });
});
