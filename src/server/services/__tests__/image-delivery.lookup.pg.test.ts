import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { dbReadFallbackCounter } from '~/server/prom/client';

/**
 * The image-delivery lookup against a REAL Postgres, because what the caller sees depends on what
 * the database hands back for the statement (column types, enum values, NULLs, exact matching, how
 * a bad parameter fails), which no mock reaches.
 *
 * Each case runs the real route handler and pins what the caller sees: status code, the serialized
 * JSON body, whether it threw, the replica -> primary fallbacks taken and the Redis write.
 *
 * The replica and the primary are separate clients, pointed at separate schemas, so the fallback is
 * exercised for real: `broken` has no `Image` table (every replica read errors), `lagging` has the
 * table without some rows (a replica that has not caught up), `primary` has every row.
 *
 * Runs in CI on the `unit` job's throwaway Postgres (the URL that job sets for the hot-reads-2
 * parity suite); the last test fails there if that wiring is lost. Locally it skips without a URL,
 * which must point at a THROWAWAY database: the suite drops and recreates its own schemas.
 */
const databaseUrl =
  process.env.IMAGE_DELIVERY_LOOKUP_DATABASE_URL ??
  process.env.KYSELY_HOT_READS_2_PARITY_DATABASE_URL;

const SCHEMAS = {
  primary: 'image_delivery_lookup',
  lagging: 'image_delivery_lookup_lagging',
  broken: 'image_delivery_lookup_broken',
} as const;
type Target = keyof typeof SCHEMAS;

const state = vi.hoisted(() => ({
  topology: { read: 'primary', write: 'primary' } as { read: string; write: string },
  // One real Kysely client per schema, over pg with the app's type parsers (createKyselyClients).
  kysely: {} as Record<string, { getExecutor(): unknown }>,
  used: { read: 0, write: 0 },
}));

// The lookup runs through Kysely over the pg pools. Each app client resolves, per statement, to the
// schema the topology names, and counts the statements it ran.
vi.mock('~/server/db/kyselyDb.lazy', () => {
  const db = {
    kyselyRead: {
      getExecutor: () => (state.used.read++, state.kysely[state.topology.read].getExecutor()),
    },
    kyselyWrite: {
      getExecutor: () => (state.used.write++, state.kysely[state.topology.write].getExecutor()),
    },
  };
  return { loadKyselyDb: async () => db };
});

// The shared internal-auth check is not under test here; mirrors image-delivery.test.ts.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

import handler from '~/pages/api/internal/image-delivery/[id]';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
// Every id is distinct, and none equals another field's value.
type Row = {
  id: number;
  url: string;
  hideMeta: boolean;
  type: 'image' | 'video' | 'audio';
  mimeType: string | null;
  ingestion: string;
};
const VISIBLE = 'lookup/visible.jpeg';
const HIDDEN = 'lookup/hidden.mp4';
const SHARED = 'lookup/shared.png';
const GONE = 'lookup/gone.webp';
const GONE_HIDDEN = 'lookup/gone-hidden.webp';
const NO_MIME = 'lookup/legacy.jpeg';
const EMPTY_MIME = 'lookup/empty-mime.jpeg';
const PADDED_MIME = 'lookup/padded-mime.gif';
const AUDIO = 'lookup/sound.mp3';
const UNICODE = 'パリティ/画像 1.jpeg';
const QUOTED = "lookup/it's.jpeg";
const LONG = `lookup/${'x'.repeat(4000)}.jpeg`;
const ASTRAL = 'lookup/\u{1F3A8} art.png'; // a surrogate PAIR: well-formed, must be found
const MISSING = 'lookup/missing.jpeg';

const ROWS: Row[] = [
  {
    id: 9101,
    url: VISIBLE,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/jpeg',
    ingestion: 'Scanned',
  },
  {
    id: 9102,
    url: HIDDEN,
    hideMeta: true,
    type: 'video',
    mimeType: 'video/mp4',
    ingestion: 'Scanned',
  },
  // Two rows share a url: the most restrictive (hideMeta) wins.
  {
    id: 9103,
    url: SHARED,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Scanned',
  },
  {
    id: 9104,
    url: SHARED,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Pending',
  },
  // Source known gone: left out unless it hides its metadata.
  {
    id: 9105,
    url: GONE,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/webp',
    ingestion: 'NotFound',
  },
  {
    id: 9106,
    url: GONE_HIDDEN,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/webp',
    ingestion: 'NotFound',
  },
  { id: 9107, url: NO_MIME, hideMeta: false, type: 'image', mimeType: null, ingestion: 'Scanned' },
  { id: 9108, url: EMPTY_MIME, hideMeta: true, type: 'image', mimeType: '', ingestion: 'Error' },
  {
    id: 9109,
    url: PADDED_MIME,
    hideMeta: false,
    type: 'image',
    mimeType: '  image/gif ',
    ingestion: 'Blocked',
  },
  {
    id: 9110,
    url: AUDIO,
    hideMeta: true,
    type: 'audio',
    mimeType: 'audio/mpeg',
    ingestion: 'Rescan',
  },
  {
    id: 9111,
    url: UNICODE,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/jpeg',
    ingestion: 'Scanned',
  },
  {
    id: 9112,
    url: QUOTED,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/jpeg',
    ingestion: 'Scanned',
  },
  {
    id: 9113,
    url: LONG,
    hideMeta: false,
    type: 'video',
    mimeType: 'video/webm',
    ingestion: 'Scanned',
  },
  {
    id: 9114,
    url: ASTRAL,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Scanned',
  },
];
// The lagging replica has not seen these yet.
const NOT_YET_REPLICATED = new Set([HIDDEN, SHARED]);

const MEDIA_TYPES = ['image', 'video', 'audio'];
const INGESTION = [
  'Pending',
  'Scanned',
  'Error',
  'Blocked',
  'NotFound',
  'PendingManualAssignment',
  'Rescan',
];

/** Types and nullability follow `schema.full.prisma`; enums are real, because the statement casts. */
function ddl(schema: string, rows: Row[] | null) {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const statements = [`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, `CREATE SCHEMA "${schema}"`];
  if (!rows) return statements;
  statements.push(
    `CREATE TYPE "${schema}"."MediaType" AS ENUM (${MEDIA_TYPES.map(q).join(', ')})`,
    `CREATE TYPE "${schema}"."ImageIngestionStatus" AS ENUM (${INGESTION.map(q).join(', ')})`,
    `CREATE TABLE "${schema}"."Image" (
      "id" INTEGER NOT NULL PRIMARY KEY,
      "url" TEXT NOT NULL,
      "hideMeta" BOOLEAN NOT NULL DEFAULT false,
      "type" "${schema}"."MediaType" NOT NULL DEFAULT 'image',
      "mimeType" TEXT,
      "ingestion" "${schema}"."ImageIngestionStatus" NOT NULL DEFAULT 'Pending'
    )`
  );
  for (const row of rows)
    statements.push(
      `INSERT INTO "${schema}"."Image" (id, url, "hideMeta", type, "mimeType", ingestion) VALUES (${
        row.id
      }, ${q(row.url)}, ${row.hideMeta}, ${q(row.type)}, ${
        row.mimeType === null ? 'NULL' : q(row.mimeType)
      }, ${q(row.ingestion)})`
    );
  return statements;
}

// ── Running one request ─────────────────────────────────────────────────────────────────────
function makeRes() {
  const res = { statusCode: 0, body: undefined as unknown } as NextApiResponse & {
    statusCode: number;
    body: unknown;
  };
  res.status = vi.fn((code: number) => ((res.statusCode = code), res)) as never;
  res.json = vi.fn((body: unknown) => ((res.body = body), res)) as never;
  return res;
}

type Outcome = {
  status: number | null;
  body: unknown;
  threw: boolean;
  fallbacks: unknown[][];
  cacheWrites: unknown[][];
};

const kyselyClients = {} as Record<Target, Kysely<unknown>>;

async function request(
  query: Record<string, unknown>,
  topology: { read: Target; write: Target } = { read: 'primary', write: 'primary' }
): Promise<{ seen: Outcome; used: [number, number] }> {
  state.topology = topology;
  state.used = { read: 0, write: 0 };
  vi.clearAllMocks();

  const res = makeRes();
  let threw = false;
  try {
    await handler({ method: 'GET', query } as unknown as NextApiRequest, res);
  } catch {
    threw = true;
  }
  return {
    seen: {
      status: res.statusCode || null,
      // What the caller parses off the wire.
      body: res.body === undefined ? undefined : JSON.parse(JSON.stringify(res.body)),
      threw,
      // Copied: the next request's clearAllMocks must not empty what this one recorded.
      fallbacks: vi.mocked(dbReadFallbackCounter.inc).mock.calls.map((call) => [...call]),
      cacheWrites: vi.mocked(redisMock.redis.packed.set).mock.calls.map((call) => [...call]),
    },
    // [replica reads, primary reads]
    used: [state.used.read, state.used.write],
  };
}

const found = (row: Row, body: Record<string, unknown>) => ({
  status: 200,
  body,
  threw: false,
  fallbacks: [],
  // 3 minutes for an entry that shows metadata, an hour for one that hides it (image-delivery.service).
  cacheWrites: [
    [
      `packed:caches:image-delivery-metadata:v2:${row.url}`,
      body,
      { EX: body.hideMeta === true ? 3600 : 180 },
    ],
  ],
});
const NOT_FOUND = {
  status: 404,
  body: { error: 'Image not found' },
  threw: false,
  fallbacks: [],
  cacheWrites: [],
};
const FALLBACK = [[{ entity: 'image', caller: 'imageDelivery' }]];
const byUrl = (url: string) => ROWS.filter((r) => r.url === url).sort((a, b) => b.id - a.id)[0];

describe.skipIf(!databaseUrl)('image-delivery lookup against a real Postgres', () => {
  beforeAll(async () => {
    const url = databaseUrl as string;
    const admin = new PrismaClient({ datasourceUrl: url });
    const statements = [
      ...ddl(SCHEMAS.primary, ROWS),
      ...ddl(
        SCHEMAS.lagging,
        ROWS.filter((r) => !NOT_YET_REPLICATED.has(r.url))
      ),
      ...ddl(SCHEMAS.broken, null),
    ];
    for (const statement of statements) await admin.$executeRawUnsafe(statement);
    await admin.$disconnect();

    for (const target of Object.keys(SCHEMAS) as Target[]) {
      kyselyClients[target] = createKyselyClients<unknown>({
        connectionString: url,
        singleClient: true,
        options: `-c search_path="${SCHEMAS[target]}"`,
      }).db;
      state.kysely[target] = kyselyClients[target];
    }
    // Every lookup misses the cache, so every one reaches the database.
    redisMock.redis.packed.get.mockImplementation(async () => null);
    redisMock.redis.packed.set.mockImplementation(async () => undefined);
  });

  beforeEach(() => {
    state.topology = { read: 'primary', write: 'primary' };
  });

  afterEach(() => {
    // Through Kysely only: the Prisma query engine is never reached, on either side.
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    const url = databaseUrl as string;
    for (const target of Object.keys(SCHEMAS) as Target[]) {
      await kyselyClients[target]?.destroy();
    }
    const admin = new PrismaClient({ datasourceUrl: url });
    for (const schema of Object.values(SCHEMAS))
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });

  describe('found', () => {
    it.each<[string, string, Record<string, unknown>]>([
      [
        'hideMeta false, an image',
        VISIBLE,
        { id: 9101, url: VISIBLE, hideMeta: false, type: 'image', mimeType: 'image/jpeg' },
      ],
      [
        'hideMeta true, a video',
        HIDDEN,
        { id: 9102, url: HIDDEN, hideMeta: true, type: 'video', mimeType: 'video/mp4' },
      ],
      [
        'two rows share the url: the hideMeta one wins',
        SHARED,
        { id: 9104, url: SHARED, hideMeta: true, type: 'image', mimeType: 'image/png' },
      ],
      [
        'source gone but hiding its metadata: kept',
        GONE_HIDDEN,
        { id: 9106, url: GONE_HIDDEN, hideMeta: true, type: 'image', mimeType: 'image/webp' },
      ],
      [
        'NULL mimeType',
        NO_MIME,
        { id: 9107, url: NO_MIME, hideMeta: false, type: 'image', mimeType: null },
      ],
      [
        'empty mimeType reads as null',
        EMPTY_MIME,
        { id: 9108, url: EMPTY_MIME, hideMeta: true, type: 'image', mimeType: null },
      ],
      [
        'padded mimeType is trimmed',
        PADDED_MIME,
        { id: 9109, url: PADDED_MIME, hideMeta: false, type: 'image', mimeType: 'image/gif' },
      ],
      [
        'audio',
        AUDIO,
        { id: 9110, url: AUDIO, hideMeta: true, type: 'audio', mimeType: 'audio/mpeg' },
      ],
      [
        'a non-ASCII url with a space',
        UNICODE,
        { id: 9111, url: UNICODE, hideMeta: false, type: 'image', mimeType: 'image/jpeg' },
      ],
      [
        'a url with a quote',
        QUOTED,
        { id: 9112, url: QUOTED, hideMeta: true, type: 'image', mimeType: 'image/jpeg' },
      ],
      [
        'a 4k-character url',
        LONG,
        { id: 9113, url: LONG, hideMeta: false, type: 'video', mimeType: 'video/webm' },
      ],
      [
        'a url with an astral character (a surrogate pair)',
        ASTRAL,
        { id: 9114, url: ASTRAL, hideMeta: true, type: 'image', mimeType: 'image/png' },
      ],
    ])('%s', async (_, id, body) => {
      const { seen, used } = await request({ id });
      expect(seen).toStrictEqual(found(byUrl(id), body));
      expect(used).toEqual([1, 0]);
    });
  });

  describe('not found', () => {
    it.each<[string, string]>([
      ['no row', MISSING],
      ['source gone, metadata visible: left out', GONE],
      // The match is exact: case, whitespace and an injection attempt each miss.
      ['different case', VISIBLE.toUpperCase()],
      ['leading space', ` ${VISIBLE}`],
      ['trailing space', `${VISIBLE} `],
      ['a quoted predicate', `${VISIBLE}' OR '1'='1`],
      ['a LIKE wildcard', 'lookup/%'],
      ['an empty id', ''],
    ])('%s', async (_, id) => {
      const { seen, used } = await request({ id });
      expect(seen).toStrictEqual(NOT_FOUND);
      expect(used).toEqual([1, 0]);
    });
  });

  describe('malformed ids', () => {
    it('an id Postgres cannot store (NUL byte): falls back to the primary, then fails', async () => {
      const { seen, used } = await request({ id: `${VISIBLE}\u0000` });
      expect(seen).toStrictEqual({
        status: null,
        body: undefined,
        threw: true,
        fallbacks: FALLBACK,
        cacheWrites: [],
      });
      expect(used).toEqual([1, 1]);
    });

    // A lone surrogate does not reach this route over HTTP: percent-decoding the path refuses it
    // with a 400, and the query parsers turn it into U+FFFD. The form that does arrive is U+FFFD.
    it('an id holding U+FFFD (what a lone surrogate arrives as): not found', async () => {
      const { seen, used } = await request({ id: `${VISIBLE}\uFFFD` });
      expect(seen).toStrictEqual(NOT_FOUND);
      expect(used).toEqual([1, 0]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a repeated id (an array)', { id: [VISIBLE, HIDDEN] }],
      ['no id', {}],
      ['a numeric id', { id: 9101 }],
    ])('%s: refused before any lookup', async (_, query) => {
      const { seen, used } = await request(query);
      expect(seen.status).toBe(400);
      expect(seen.threw).toBe(false);
      expect(used).toEqual([0, 0]);
    });
  });

  describe('replica and primary', () => {
    it('replica errors: the primary answers, after one counted fallback', async () => {
      const { seen, used } = await request({ id: HIDDEN }, { read: 'broken', write: 'primary' });
      expect(seen).toStrictEqual({
        ...found(byUrl(HIDDEN), {
          id: 9102,
          url: HIDDEN,
          hideMeta: true,
          type: 'video',
          mimeType: 'video/mp4',
        }),
        fallbacks: FALLBACK,
      });
      expect(used).toEqual([1, 1]);
    });

    it('replica errors and the url is unknown: a not-found from the primary', async () => {
      const { seen, used } = await request({ id: MISSING }, { read: 'broken', write: 'primary' });
      expect(seen).toStrictEqual({ ...NOT_FOUND, fallbacks: FALLBACK });
      expect(used).toEqual([1, 1]);
    });

    it('replica has not caught up: a not-found, and the primary is NOT asked', async () => {
      // Only an error falls back; an empty replica answer is a not-found, as it always was.
      const { seen, used } = await request({ id: HIDDEN }, { read: 'lagging', write: 'primary' });
      expect(seen).toStrictEqual(NOT_FOUND);
      expect(used).toEqual([1, 0]);
    });

    it('a lagging replica still answers the rows it has', async () => {
      const { seen } = await request({ id: VISIBLE }, { read: 'lagging', write: 'primary' });
      expect(seen).toStrictEqual(
        found(byUrl(VISIBLE), {
          id: 9101,
          url: VISIBLE,
          hideMeta: false,
          type: 'image',
          mimeType: 'image/jpeg',
        })
      );
    });

    it('replica and primary both error: the request fails after one fallback', async () => {
      const { seen, used } = await request({ id: VISIBLE }, { read: 'broken', write: 'broken' });
      expect(seen).toStrictEqual({
        status: null,
        body: undefined,
        threw: true,
        fallbacks: FALLBACK,
        cacheWrites: [],
      });
      expect(used).toEqual([1, 1]);
    });
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the database is wired', () => {
  expect(databaseUrl).toBeTruthy();
});
