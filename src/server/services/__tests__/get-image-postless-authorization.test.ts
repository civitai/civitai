import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// `Image.postId` is ON DELETE SET NULL, so an image outlives a deleted post. `getImage` used to
// inner-join Post for non-moderators, dropping those rows before the ownership clause ran — the
// owner 404'd on their own image while a moderator loaded it fine. The statement's shape IS the
// authorization decision, which is why these assert on rendered SQL.
//
// Mock recipe follows image-hide-challenges-exclusion.test.ts.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { getImage } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VIEWER = 71806;
const IMAGE_ID = 137353037;

type Frag = { strings: readonly string[]; values: readonly unknown[] };
const isFrag = (v: unknown): v is Frag =>
  !!v &&
  typeof v === 'object' &&
  Array.isArray((v as Frag).strings) &&
  Array.isArray((v as Frag).values);

const literal = (v: unknown) =>
  v === undefined || v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v);

// Bindings are rendered resolved, not as `?`. A placeholder hides exactly what these tests are
// about: which id is bound into the postless ownership check. Built by interleaving `strings` and
// `values` — never by splitting `.sql` on `?`, because `imageOnSiteSql()` contains the jsonb
// existence operator and a `?`-split mis-aligns every binding after it.
function resolve(strings: readonly string[], values: readonly unknown[]): string {
  return strings
    .map((chunk, i) => {
      if (i === 0) return chunk;
      const value = values[i - 1];
      return (isFrag(value) ? resolve(value.strings, value.values) : literal(value)) + chunk;
    })
    .join('');
}

function renderLastQuery() {
  const call = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
  if (!call) throw new Error('$queryRaw was never called');
  const [strings, ...values] = call as [string[], ...unknown[]];
  return resolve(strings, values).replace(/\s+/g, ' ');
}

// getImage throws not-found on an empty result, before any of the enrichment fetches. The
// statement is already assembled by then. The message is pinned so a mock that breaks for an
// unrelated reason cannot be laundered into "the not-found path ran".
async function captureQuery(args: Parameters<typeof getImage>[0]) {
  await expect(getImage(args)).rejects.toThrow(/No image with id/);
  return renderLastQuery();
}

describe('getImage postless authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  });

  it('left-joins Post so a postless row survives to the WHERE', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    expect(sql).toContain('LEFT JOIN "Post" p ON p.id = i."postId"');
    // The gate must not move back into the ON clause: there it discards the row instead of
    // failing it, and no WHERE conjunct can recover a row the join never produced.
    expect(sql).not.toMatch(/JOIN "Post" p ON p\.id = i\."postId" AND/);
  });

  it('admits a postless image only to the viewer who owns it', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    // Resolved, so binding the image id in place of the viewer fails here. Drop the `i."userId"`
    // conjunct entirely and every never-posted upload becomes fetchable by id.
    expect(sql).toContain(`i."postId" IS NULL AND i."userId" = ${VIEWER}`);
  });

  it('keeps the owner escape on the private-post clause', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    expect(sql).toContain(
      `(i."postId" IS NULL OR p."availability" != 'Private' OR p."userId" = ${VIEWER})`
    );
  });

  it('still requires a published or owned post when one exists', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    expect(sql).toContain(`p."publishedAt" < now() OR p."userId" = ${VIEWER}`);
  });

  it('binds NULL for an anonymous viewer, so every ownership branch fails closed', async () => {
    const sql = await captureQuery({ id: IMAGE_ID });

    expect(sql).toContain('i."postId" IS NULL AND i."userId" = NULL');
  });

  it('emits no Post reference when the caller opts out of the post', async () => {
    // `withoutPost` is a client-supplied field on a public procedure, and the article lightbox
    // sends it. Emitting the post gates without the join is `missing FROM-clause entry for "p"`.
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER, withoutPost: true });

    expect(sql).not.toContain('JOIN "Post"');
    expect(sql).not.toContain('p."');
  });

  it('leaves the moderator path ungated', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER, isModerator: true });

    expect(sql).toContain('LEFT JOIN "Post" p ON p.id = i."postId"');
    expect(sql).not.toContain('p."publishedAt" < now()');
  });
});
