import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as z from 'zod';

/**
 * The audit row records an endpoint's own parameters.
 *
 * `collectInput` merges the query string into the request input, so a request can arrive carrying
 * fields the endpoint never declared. Those are not part of what an action was called with. The
 * audited payload therefore takes its KEYS from the schema — an allowlist, so a field added to the
 * request surface later needs no maintenance here — and its VALUES as the request sent them, since
 * changing those would make new rows disagree with stored ones wherever a value arrived as a
 * string.
 *
 * Pinned because the audited value and the validated value are both derived from the same raw
 * object, so a change that reverts to the raw one is invisible in every assertion about behaviour.
 */

const { mockAudit, handlerInput } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  handlerInput: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({
    user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null },
  })),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => res.status(500).json({ message: (e as Error).message }),
}));

import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const handler = defineModeratorEndpoint('test.auditPayload', {
  summary: 'test fixture',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId: z.coerce.number() }),
  async handler(input) {
    return { ok: true, userId: input.userId };
  },
});

/** A schema whose parse output is an object with NO own enumerable keys — `Object.keys(new Date())`
 *  is `[]`. No endpoint has a top-level one today; emptiness is the condition an array does not
 *  trip, so both arms of the guard need their own case or one of them is untested. */
const dateHandler = defineModeratorEndpoint('test.dateInput', {
  summary: 'test fixture',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.preprocess((v) => (v as { userId?: unknown })?.userId, z.coerce.date()),
  async handler() {
    return { ok: true };
  },
});

/** No endpoint parses to an array today. This one exists so the guard against that case is
 *  exercised rather than merely present — an array's keys are '0','1',… , which would filter every
 *  real key out and write an empty audit payload without erroring. */
const arrayHandler = defineModeratorEndpoint('test.arrayInput', {
  summary: 'test fixture',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.preprocess((v) => [(v as { userId?: unknown })?.userId], z.array(z.string())),
  async handler() {
    return { ok: true };
  },
});

/** Declares an exclusion, so the SHARED facility is exercised here rather than only through the one
 *  endpoint that uses it. */
const excludingHandler = defineModeratorEndpoint('test.auditExclude', {
  summary: 'test fixture',
  rateLimit: { max: 60, windowSeconds: 60 },
  auditExclude: ['typedName'],
  input: z.object({ userId: z.coerce.number(), typedName: z.string() }),
  async handler(input) {
    handlerInput(input);
    return { ok: true };
  },
});

function call(query: Record<string, unknown>, h: typeof handler = handler) {
  const req = { method: 'POST', headers: {}, body: {}, query } as Parameters<typeof handler>[0];
  const res = {
    status: () => res,
    json: () => res,
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return h(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('a moderator endpoint audits the parameters it was called with', () => {
  it('records the endpoint parameter', async () => {
    await call({ userId: '42' });

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0].payload).toMatchObject({ userId: '42' });
  });

  it('records nothing the endpoint did not declare', async () => {
    await call({ userId: '42', extra: 'abc', anythingElse: 'ghi' });

    expect(mockAudit).toHaveBeenCalledTimes(1);
    // Exactly the endpoint's own parameter. `anythingElse` is in here deliberately: an allowlist
    // covers the field nobody thought to name, which a denylist of known field names does not.
    expect(mockAudit.mock.calls[0][0].payload).toEqual({ userId: '42' });
  });

  // What this controls is that the VALUE is carried rather than hardcoded; the case above already
  // excludes an empty payload.
  it('still records the parameter when undeclared fields are present', async () => {
    await call({ userId: '99', extra: 'abc' });

    expect(mockAudit.mock.calls[0][0].payload).toEqual({ userId: '99' });
  });
});

describe('a schema that does not parse to a plain object', () => {
  it('still records the request parameters rather than an empty payload', async () => {
    await call({ userId: '42' }, arrayHandler as unknown as typeof handler);

    expect(mockAudit).toHaveBeenCalledTimes(1);
    // Without the array guard this is `{}` — the keys of an array are '0','1',… , which match no
    // real parameter, and the payload is emptied with nothing to indicate it happened.
    expect(mockAudit.mock.calls[0][0].payload).toEqual({ userId: '42' });
  });
});

describe('a schema whose parse output has no own keys', () => {
  it('still records the request parameters rather than an empty payload', async () => {
    await call({ userId: '2026-09-21' }, dateHandler as unknown as typeof handler);

    expect(mockAudit).toHaveBeenCalledTimes(1);
    // Without the emptiness condition `declared` is the empty set, every key is filtered out, and a
    // privileged action's audit row records nothing it was called with — silently.
    expect(mockAudit.mock.calls[0][0].payload).toEqual({ userId: '2026-09-21' });
  });
});

describe('a parameter an endpoint declares but does not want recorded', () => {
  it('is read by the handler and kept out of the audit row', async () => {
    await call({ userId: '42', typedName: 'confirmation' }, excludingHandler as typeof handler);

    expect(handlerInput).toHaveBeenCalledWith({ userId: 42, typedName: 'confirmation' });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0].payload).toEqual({ userId: '42' });
    // The whole row, not the one key we thought to name — the value must not reappear in another
    // column.
    expect(JSON.stringify(mockAudit.mock.calls[0][0])).not.toContain('confirmation');
  });

  it('leaves every other declared parameter in place', async () => {
    await call({ userId: '99', typedName: 'confirmation' }, excludingHandler as typeof handler);

    expect(mockAudit.mock.calls[0][0].payload).toEqual({ userId: '99' });
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      action: 'test.auditExclude',
      outcome: 'ok',
    });
  });
});
