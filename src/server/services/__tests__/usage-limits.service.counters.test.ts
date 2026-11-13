import type { NextApiRequest } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as UsageLimitsModule from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';

// A stand-in calendar-window entry, mid-registry so the sort is what puts it in place.
const MONTHLY = 'gifts.test-monthly';
vi.mock('~/shared/constants/usage-limits', async (importOriginal) => {
  const actual = await importOriginal<typeof UsageLimitsModule>();
  const def = {
    id: MONTHLY,
    area: 'gifts',
    kind: 'product',
    label: 'Gifts per month',
    window: { type: 'utc-month' },
    base: 5,
  } as unknown as (typeof actual.usageLimitDefs)[number];
  const at = actual.usageLimitDefs.findIndex((d) => d.area === 'comments');
  if (at < 1) throw new Error('harness broken: no comments entry to insert before');
  return {
    ...actual,
    usageLimitDefs: [
      ...actual.usageLimitDefs.slice(0, at),
      def,
      ...actual.usageLimitDefs.slice(at),
    ],
    getUsageLimitDef: (id: string) => (id === MONTHLY ? def : actual.getUsageLimitDef(id)),
  };
});

const { getUsageLimits } = await import('~/server/services/usage-limits.service');
const { calendarWindow, usageLimitCounters } = await import(
  '~/server/services/usage-limit-counters'
);

const NOW = Date.UTC(2026, 10, 18, 15, 30);
const NEXT_MONTH = new Date(Date.UTC(2026, 11, 1)).toISOString();
const req = { headers: {}, socket: {} } as unknown as NextApiRequest;
const user = { id: 7, tier: 'free', createdAt: new Date(2020, 0, 1) } as unknown as SessionUser;
const counters = usageLimitCounters as Record<string, unknown>;

const rowsFor = async (ids?: string[], who: SessionUser = user) =>
  (await getUsageLimits({ tokenScope: TokenScope.Full, user: who, req, ids })).limits;

// The real gifts counter reads the database; this suite has none.
const giftsCounter = counters['gifts.monthly'];
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  counters['gifts.monthly'] = async () => 0;
});
afterEach(() => {
  delete counters[MONTHLY];
  counters['gifts.monthly'] = giftsCounter;
  vi.useRealTimers();
});

describe('calendar-window product limits', () => {
  it("list a registered counter's count for the current UTC month", async () => {
    const counter = vi.fn(async () => 2);
    counters[MONTHLY] = counter;

    const [row] = await rowsFor([MONTHLY]);

    expect(counter).toHaveBeenCalledWith({
      user,
      req,
      start: new Date(Date.UTC(2026, 10, 1)),
      end: new Date(NEXT_MONTH),
    });
    expect(row).toEqual({
      id: MONTHLY,
      area: 'gifts',
      label: 'Gifts per month',
      limit: 5,
      used: 2,
      remaining: 3,
      windowSeconds: null,
      window: 'utc-month',
      nextAt: null,
      resetAt: NEXT_MONTH,
    });
  });

  it('at the limit, the next use is at the month boundary', async () => {
    counters[MONTHLY] = async () => 7;
    const [row] = await rowsFor([MONTHLY]);
    expect(row).toMatchObject({ used: 7, remaining: 0, nextAt: NEXT_MONTH });
  });

  it('a moderator gets the real count: the enforcing service decides exemption', async () => {
    counters[MONTHLY] = async () => 1;
    const moderator = { ...user, id: 10, isModerator: true } as unknown as SessionUser;
    const [row] = await rowsFor([MONTHLY], moderator);
    expect(row).toMatchObject({ limit: 5, used: 1 });
  });

  it('has no row without a counter, and sorts into registry order with one', async () => {
    expect((await rowsFor()).map((l) => l.id)).not.toContain(MONTHLY);
    counters[MONTHLY] = async () => 0;
    const ids = (await rowsFor()).map((l) => l.id);
    const { usageLimitDefs } = await import('~/shared/constants/usage-limits');
    const registryOrder = usageLimitDefs.map((d) => d.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(registryOrder);
    expect(ids.indexOf(MONTHLY)).toBeGreaterThan(0);
    expect(ids.indexOf(MONTHLY)).toBeLessThan(ids.length - 1);
  });

  it('has no row when the counter says the user cannot reach the feature', async () => {
    counters[MONTHLY] = vi.fn(async () => null);
    expect(await rowsFor([MONTHLY])).toEqual([]);
  });

  it('ids narrow counted rows too', async () => {
    const counter = vi.fn(async () => 0);
    counters[MONTHLY] = counter;
    expect(await rowsFor(['posts.daily'])).not.toContainEqual(
      expect.objectContaining({ id: MONTHLY })
    );
    expect(counter).not.toHaveBeenCalled();
  });
});

describe('calendarWindow', () => {
  it('rolls December into January and a day into the next', () => {
    expect(calendarWindow('utc-month', Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      start: new Date(Date.UTC(2026, 11, 1)),
      end: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(calendarWindow('utc-day', Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      start: new Date(Date.UTC(2026, 11, 31)),
      end: new Date(Date.UTC(2027, 0, 1)),
    });
  });
});
