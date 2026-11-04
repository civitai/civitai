import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// A scheduled announcement must go live when its `startsAt` passes, not when the per-domain
// cache next refills. The cache is filled once and kept for a day (only a moderator
// upsert/delete clears it), while `startsAt` is applied on read — so a fill that left out
// not-yet-started rows showed them up to a day late, at a different moment on each domain.
//
// Driven end to end through getCurrentAnnouncements: the cache fill runs against a fake
// `findMany` that EVALUATES the where clause it is given over a fixture table, and redis is
// a store that honours `EX`, so each test observes what a reader sees as time passes.

vi.mock('~/server/common/constants', () => ({ CacheTTL: { day: 86400 } }));
vi.mock('~/server/utils/pagination-helpers', () => ({
  DEFAULT_PAGE_SIZE: 20,
  getPagination: vi.fn(),
  getPagingData: vi.fn(),
}));
vi.mock('~/shared/utils/prisma/enums', () => ({
  DomainColor: { all: 'all', green: 'green', blue: 'blue', red: 'red' },
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MEMO_TTL = 30_000;
const T0 = new Date('2026-11-01T06:00:00.000Z').getTime();

type Row = {
  id: number;
  disabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  domain: string[];
  userId: number | null;
};

let table: Row[] = [];

// ---- a where-clause evaluator for exactly the shapes the fill uses; anything else throws, so
// a predicate this does not understand fails the test instead of matching everything.
type Cond = Record<string, unknown>;
function matchField(value: Date | null | number | string[], cond: unknown): boolean {
  if (cond === null) return value === null;
  const c = cond as Cond;
  for (const [op, operand] of Object.entries(c)) {
    if (op === 'equals') {
      if (operand !== null) throw new Error(`unsupported equals ${String(operand)}`);
      if (value !== null) return false;
    } else if (op === 'lte' || op === 'gte') {
      if (!(value instanceof Date)) return false;
      const bound = (operand as Date).getTime();
      if (op === 'lte' ? value.getTime() > bound : value.getTime() < bound) return false;
    } else if (op === 'hasSome') {
      if (!(value as string[]).some((d) => (operand as string[]).includes(d))) return false;
    } else throw new Error(`unsupported operator ${op}`);
  }
  return true;
}
function matches(row: Row, where: Cond): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as Cond[]).every((w) => matches(row, w))) return false;
    } else if (key === 'OR') {
      if (!(cond as Cond[]).some((w) => matches(row, w))) return false;
    } else if (key === 'disabled') {
      if (row.disabled !== cond) return false;
    } else if (key === 'startsAt' || key === 'endsAt' || key === 'domain' || key === 'userId') {
      if (!matchField(row[key], cond)) return false;
    } else throw new Error(`unsupported where key ${key}`);
  }
  return true;
}

// ---- redis with expiry, on the faked clock.
const store = new Map<string, { value: string; expiresAt: number }>();

async function loadService() {
  vi.resetModules();
  return import('../announcement.service');
}

function scheduled(id: number, startsAt: number, extra: Partial<Row> = {}): Row {
  return {
    id,
    disabled: false,
    startsAt: new Date(startsAt),
    endsAt: null,
    domain: ['all'],
    userId: null,
    ...extra,
  };
}

const ids = (xs: { id: number }[]) => xs.map((x) => x.id).sort((a, b) => a - b);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  store.clear();
  table = [];
  dbMock.dbWrite.announcement.findMany.mockImplementation((async (args: { where: Cond }) =>
    table
      .filter((row) => matches(row, args.where))
      .map((row) => ({
        ...row,
        createdAt: new Date(T0 - DAY),
        title: `t${row.id}`,
        content: 'c',
        color: 'blue',
        emoji: null,
        metadata: {},
        targetUsers: [],
      }))) as never);
  redisMock.redis.get.mockImplementation((async (key: string) => {
    const hit = store.get(key);
    if (!hit || hit.expiresAt <= Date.now()) return null;
    return hit.value;
  }) as never);
  redisMock.redis.set.mockImplementation((async (
    key: string,
    value: string,
    opts: { EX: number }
  ) => {
    store.set(key, { value, expiresAt: Date.now() + opts.EX * 1000 });
    return 'OK';
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('a scheduled announcement goes live at its start, without a cache clear', () => {
  it('appears once its start passes, served from the entry filled before it started', async () => {
    const { getCurrentAnnouncements } = await loadService();
    // Starts late in the entry's lifetime — the case a short look-ahead would miss.
    table = [scheduled(1, T0 - HOUR), scheduled(2, T0 + 23 * HOUR)];

    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([1]);
    expect(dbMock.dbWrite.announcement.findMany).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 23 * HOUR - MEMO_TTL);
    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([1]);

    vi.setSystemTime(T0 + 23 * HOUR + 1);
    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([1, 2]);
    // Control: the entry was never refilled, so it is the start filter on read that let #2 in.
    expect(dbMock.dbWrite.announcement.findMany).toHaveBeenCalledTimes(1);
  });

  it('every domain shows it at the same moment, whenever each entry was filled', async () => {
    const { getCurrentAnnouncements } = await loadService();
    table = [scheduled(7, T0 + 12 * HOUR)];

    await getCurrentAnnouncements({ domain: 'green' as never });
    vi.setSystemTime(T0 + 6 * HOUR);
    await getCurrentAnnouncements({ domain: 'blue' as never });
    await getCurrentAnnouncements({});

    vi.setSystemTime(T0 + 12 * HOUR + 1);
    expect(ids(await getCurrentAnnouncements({ domain: 'green' as never }))).toEqual([7]);
    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([7]);
    expect(ids(await getCurrentAnnouncements({}))).toEqual([7]);
    expect(dbMock.dbWrite.announcement.findMany).toHaveBeenCalledTimes(3);
  });

  it('one scheduled beyond the entry lifetime appears at its start via the next fill', async () => {
    const { getCurrentAnnouncements } = await loadService();
    table = [scheduled(3, T0 + 5 * DAY)];

    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([]);
    vi.setSystemTime(T0 + 5 * DAY + 1);
    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([3]);
  });

  it('still leaves out disabled, ended and other-domain rows at fill', async () => {
    const { getCurrentAnnouncements } = await loadService();
    table = [
      scheduled(1, T0 - HOUR),
      scheduled(2, T0 + HOUR, { disabled: true }),
      scheduled(3, T0 - DAY, { endsAt: new Date(T0 - HOUR) }),
      scheduled(4, T0 + HOUR, { domain: ['red'] }),
      scheduled(5, T0 + HOUR, { userId: 99 }),
    ];

    await getCurrentAnnouncements({ domain: 'blue' as never });
    vi.setSystemTime(T0 + 2 * HOUR);
    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([1]);
    // Positive control: the same scheduled row on the right domain does go live.
    table.push(scheduled(6, T0 + 3 * HOUR, { domain: ['blue'] }));
    store.clear();
    vi.setSystemTime(T0 + 3 * HOUR + MEMO_TTL + 1);
    expect(ids(await getCurrentAnnouncements({ domain: 'blue' as never }))).toEqual([1, 6]);
  });
});
