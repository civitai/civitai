import { describe, it, expect, vi, beforeEach } from 'vitest';

// `getInfiniteImagesHandler` spreads the whole `ctx.user` session object into the
// image search input for business logic. Both `search-error` catch blocks in
// image.service used to log that input verbatim, which shipped `email`,
// `emailVerified`, `username` and `createdAt` for every erroring search —
// measured at 331,164 records/day in production, each naming a real account.
//
// Two levels of coverage here, because they fail independently:
//   1. `redactSearchInputForLog` actually removes the session user (behaviour).
//   2. The two catch blocks CALL it (the seam). A correct redactor that nothing
//      invokes is exactly the shape this bug already had — a unit test of the
//      helper alone would stay green through a revert of either call site, so
//      the seam cases drive the real catch path and inspect what was logged.
//
// Mock preamble mirrors image-metrics-timeout.test.ts: the smallest set of
// stubs that lets image.service import without booting real infra.

import type * as LoggingClient from '~/server/logging/client';
import type * as MeilisearchClient from '~/server/meilisearch/client';

const { logToAxiomMock, fetchDocumentsAbortableMock } = vi.hoisted(() => ({
  logToAxiomMock: vi.fn(() => Promise.resolve()),
  fetchDocumentsAbortableMock: vi.fn(),
}));

vi.mock('~/server/logging/client', async (importOriginal) => {
  const actual = await importOriginal<typeof LoggingClient>();
  return { ...actual, logToAxiom: logToAxiomMock };
});

// metricsSearchClient must be TRUTHY or both functions early-return before the
// try/catch we are testing. fetchDocumentsAbortable is the throw seam.
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return {
    ...actual,
    metricsSearchClient: {},
    getMetricsSearchClient: () => ({}),
    fetchDocumentsAbortable: fetchDocumentsAbortableMock,
  };
});

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import {
  redactSearchInputForLog,
  getImagesFromSearchPreFilter,
  getImagesFromSearchPostFilter,
} from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** The real shape observed in production logs, values substituted. */
const sessionUser = {
  id: 4321,
  username: 'a-real-username',
  email: 'someone@example.com',
  emailVerified: '2024-01-02T03:04:05.000Z',
  createdAt: '2023-05-06T07:08:09.000Z',
  isModerator: false,
  muted: false,
  showNsfw: true,
  browsingLevel: 31,
  permissions: [],
  roles: [],
  meta: { scores: { total: 12, users: 3 } },
  filePreferences: { fp: 'fp16', size: 'pruned', format: 'SafeTensor' },
};

/** Every field that must never reach a log sink, with a distinctive value. */
const PII_VALUES = [
  'someone@example.com',
  'a-real-username',
  '2024-01-02T03:04:05.000Z',
  '2023-05-06T07:08:09.000Z',
];

const searchInput = {
  user: sessionUser,
  // `userId` is a SEARCH FILTER (feed-by-creator) and is NOT the session user.
  // It must survive redaction intact — remapping user.id onto it would corrupt
  // the logged query, so this doubles as the regression guard for that.
  userId: 999,
  currentUserId: 4321,
  isModerator: false,
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 31,
  include: ['tagIds'],
  headers: { src: 'getInfiniteImagesHandler' },
};

describe('redactSearchInputForLog', () => {
  it('drops the session user object entirely', () => {
    const out = redactSearchInputForLog(searchInput) as Record<string, unknown>;
    expect(out).not.toHaveProperty('user');
  });

  it('carries no PII value anywhere in its serialized output', () => {
    const serialized = JSON.stringify(redactSearchInputForLog(searchInput));
    for (const v of PII_VALUES) expect(serialized).not.toContain(v);
    // positive control: the un-redacted input DOES contain every one of them,
    // so the assertions above are capable of failing.
    const raw = JSON.stringify(searchInput);
    for (const v of PII_VALUES) expect(raw).toContain(v);
  });

  it('preserves the diagnostic fields, including the userId SEARCH FILTER', () => {
    const out = redactSearchInputForLog(searchInput) as Record<string, unknown>;
    expect(out.userId).toBe(999); // NOT overwritten with the session user's 4321
    expect(out.currentUserId).toBe(4321); // session id still available for triage
    expect(out.isModerator).toBe(false);
    expect(out.limit).toBe(20);
    expect(out.period).toBe('AllTime');
    expect(out.sort).toBe('Newest');
  });

  it('is a denylist of exactly the user key — an unknown future PII field on the session user cannot leak', () => {
    const out = redactSearchInputForLog({
      ...searchInput,
      user: { ...sessionUser, someFieldAddedLater: 'phone:+15551234567' },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('+15551234567');
  });

  it('tolerates an input with no user at all', () => {
    const { user, ...noUser } = searchInput;
    expect(() => redactSearchInputForLog(noUser)).not.toThrow();
    expect(redactSearchInputForLog(noUser)).toMatchObject({ userId: 999 });
  });
});

// The seam: these drive the REAL catch block, so they go red if either call site
// reverts to logging the raw input, which a helper-only unit test would not.
describe.each([
  ['getImagesFromSearchPreFilter', getImagesFromSearchPreFilter],
  ['getImagesFromSearchPostFilter', getImagesFromSearchPostFilter],
])('%s search-error log payload', (_name, fn) => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchDocumentsAbortableMock.mockRejectedValue(new Error('meili exploded'));
  });

  it('logs a search-error that contains NO session PII', async () => {
    type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];
    await expect(fn(searchInput as unknown as SearchArg)).rejects.toThrow('meili exploded');

    type LoggedPayload = { type?: string; input?: Record<string, unknown> };
    const searchErrorCalls = (logToAxiomMock.mock.calls as unknown as LoggedPayload[][]).filter(
      (c) => c[0]?.type === 'search-error'
    );
    // positive control: the catch block we are asserting about actually ran.
    expect(searchErrorCalls.length).toBeGreaterThan(0);

    for (const call of searchErrorCalls) {
      const payload = call[0];
      expect(payload.input).not.toHaveProperty('user');
      const serialized = JSON.stringify(payload);
      for (const v of PII_VALUES) expect(serialized).not.toContain(v);
    }
  });
});
