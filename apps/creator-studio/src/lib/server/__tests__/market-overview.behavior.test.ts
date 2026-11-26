import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Fragment = { strings: readonly string[]; values: unknown[] };
type Ident = { ident: string };

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// kysely's `sql` tag, rendered to the statement Postgres receives and run on PGlite, so the market queries and the
// seller floor are checked against real rows.
vi.mock('@civitai/db/kysely', () => {
  const render = (f: Fragment, params: unknown[]): string =>
    f.strings.reduce((out, s, i) => {
      if (i === f.values.length) return out + s;
      const v = f.values[i];
      if (v && typeof v === 'object' && 'ident' in v) return out + s + (v as Ident).ident;
      if (v && typeof v === 'object' && 'strings' in v)
        return out + s + render(v as Fragment, params);
      params.push(v);
      return `${out}${s}$${params.length}`;
    }, '');
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: Fragment & { execute: () => Promise<{ rows: unknown[] }> } = {
      strings,
      values,
      execute: async () => {
        const params: unknown[] = [];
        const text = render(frag, params);
        return { rows: (await holder.db.query(text, params)).rows };
      },
    };
    return frag;
  };
  sql.raw = (s: string): Ident => ({ ident: s });
  sql.lit = (value: number | string): Ident => ({
    ident: typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value),
  });
  sql.join = (items: Fragment[]): Fragment => ({
    strings: ['', ...items.slice(1).map(() => ', '), ''],
    values: items,
  });
  return { sql };
});

// The module reads through dbRead; these tests pass their own query path, so the real client is never built.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { marketHandler, readMarketSnapshot, snapshotReader, RETRY_AFTER_MS, TTL_MS } =
  await import('../market-overview');
const { assertFloor, marketView } = await import('$lib/analytics/market-overview');

const SDXL = 'SDXL 1.0';
const PONY = 'Pony';
let nextModel = 1;
let nextVersion = 1000;

/** One listed model with one published public version, optionally gated. */
function model(o: {
  owner: number;
  base?: string;
  type?: string;
  nsfwLevel?: number;
  gate?: { terms: object; timeframeDays?: number | null; endsAt?: string | null } | null;
  minor?: boolean;
  status?: string;
}) {
  const m = nextModel++;
  const v = nextVersion++;
  const rows = [
    `INSERT INTO "Model" (id, "userId", type, "nsfwLevel", status, minor) VALUES (${m}, ${o.owner}, '${o.type ?? 'LORA'}', ${o.nsfwLevel ?? 1}, '${o.status ?? 'Published'}', ${o.minor ?? false});`,
    `INSERT INTO "ModelVersion" (id, "modelId", "baseModel") VALUES (${v}, ${m}, '${o.base ?? SDXL}');`,
  ];
  if (o.gate)
    rows.push(
      `INSERT INTO "PaidAccess" ("entityType", "entityId", "timeframeDays", "endsAt", terms) VALUES ('ModelVersion', ${v}, ${o.gate.timeframeDays ?? 'NULL'}, ${o.gate.endsAt ? `'${o.gate.endsAt}'` : 'NULL'}, '${JSON.stringify(o.gate.terms)}');`
    );
  return { sql: rows.join('\n'), modelId: m, versionId: v };
}

const download = (price: number) => ({ download: { price }, generation: {} });

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, type text, "nsfwLevel" int, status text, availability text DEFAULT 'Public',
      mode text, poi boolean DEFAULT false, minor boolean DEFAULT false, "deletedAt" timestamp
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, "baseModel" text, status text DEFAULT 'Published',
      availability text DEFAULT 'Public', "publishedAt" timestamp DEFAULT now()
    );
    CREATE TABLE "PaidAccess" (
      "entityType" text, "entityId" int, "timeframeDays" int, "endsAt" timestamp, terms jsonb
    );
    CREATE TABLE "TagsOnModels" ("modelId" int, "tagId" int);
  `);
  const fixtures = [
    // SDXL permanent access in the 100-249 band: 5 sellers, so the cell shows. Seller 1 has two models in it.
    ...[1, 2, 3, 4, 5].map((owner) => model({ owner, gate: { terms: download(150) } })),
    model({ owner: 1, gate: { terms: download(200) } }),
    // Pony permanent access in the same band: 5 models but only 4 sellers, so it is hidden.
    ...[11, 11, 12, 13, 14].map((owner) =>
      model({ owner, base: PONY, gate: { terms: download(150) } })
    ),
    // A generation-only gate is priced at its generation price (the 500-999 band), not at 0.
    ...[21, 22, 23, 24, 25].map((owner) =>
      model({ owner, gate: { terms: { generation: { price: 600 } } } })
    ),
    // Free generation with no download tier is free, as the site's "Hide paid" filter reads it.
    ...[31, 32, 33].map((owner) =>
      model({ owner, gate: { terms: { generation: { free: true } } } })
    ),
    // Ungated free SDXL LoRAs: 2 sellers, which with the 3 gated-free sellers makes 5.
    ...[34, 35].map((owner) => model({ owner })),
    // NSFW-only and not minor: listed on civitai.red alone, and counted.
    ...[61, 62, 63, 64, 65].map((owner) =>
      model({ owner, nsfwLevel: 16, gate: { terms: download(150) } })
    ),
    // An open 7-day early-access window counts; an expired one is no gate at all.
    ...[71, 72, 73, 74, 75].map((owner) =>
      model({ owner, gate: { terms: download(150), timeframeDays: 7, endsAt: '2099-01-01' } })
    ),
    model({ owner: 76, gate: { terms: download(150), timeframeDays: 7, endsAt: '2020-01-01' } }),
    // Free NSFW LoRAs from 5 sellers: a free cell of their own.
    ...[91, 92, 93, 94, 95].map((owner) => model({ owner, nsfwLevel: 16 })),
    // Free Checkpoints from only 4 sellers: a free cell under the floor.
    ...[81, 82, 83, 84].map((owner) => model({ owner, type: 'Checkpoint' })),
    // Never counted: a poi model and a private one.
    model({ owner: 85, gate: { terms: download(150) } }),
    model({ owner: 86, gate: { terms: download(150) } }),
    // A model listed on no site (minor, with no SFW level) and a draft are never counted.
    model({ owner: 41, nsfwLevel: 16, minor: true, gate: { terms: download(150) } }),
    model({ owner: 42, status: 'Draft', gate: { terms: download(150) } }),
  ];
  await holder.db.exec(fixtures.map((f) => f.sql).join('\n'));
  // Seller 1's first model also has a generation-only version: one model in two cells.
  await holder.db.exec(`
    INSERT INTO "ModelVersion" (id, "modelId", "baseModel") VALUES (9999, ${fixtures[0].modelId}, '${SDXL}');
    INSERT INTO "PaidAccess" ("entityType", "entityId", terms) VALUES ('ModelVersion', 9999, '{"generation": {"price": 600}}');
  `);
  await holder.db.exec(`
    UPDATE "Model" SET poi = true WHERE "userId" = 85;
    UPDATE "Model" SET availability = 'Private' WHERE "userId" = 86;
  `);
  // A free model with a second public version and a draft one: two versions counted.
  const twoVersions = model({ owner: 35 });
  await holder.db.exec(`
    ${twoVersions.sql}
    INSERT INTO "ModelVersion" (id, "modelId", "baseModel") VALUES (9996, ${twoVersions.modelId}, '${SDXL}');
    INSERT INTO "ModelVersion" (id, "modelId", "baseModel", status) VALUES (9995, ${twoVersions.modelId}, '${SDXL}', 'Draft');
  `);
  // A free-generation model that also sells a version in a hidden band is paid, not free.
  const mixed = model({ owner: 51, gate: { terms: { generation: { free: true } } } });
  // A free model whose only gate is on an unpublished draft is free.
  const drafted = model({ owner: 52 });
  await holder.db.exec(`
    ${mixed.sql}
    INSERT INTO "ModelVersion" (id, "modelId", "baseModel") VALUES (9998, ${mixed.modelId}, '${SDXL}');
    INSERT INTO "PaidAccess" ("entityType", "entityId", terms) VALUES ('ModelVersion', 9998, '${JSON.stringify(download(3000))}');
    ${drafted.sql}
    INSERT INTO "ModelVersion" (id, "modelId", "baseModel", status) VALUES (9997, ${drafted.modelId}, '${SDXL}', 'Draft');
    INSERT INTO "PaidAccess" ("entityType", "entityId", "timeframeDays", terms) VALUES ('ModelVersion', 9997, 7, '${JSON.stringify(download(150))}');
  `);
});

let snap: Awaited<ReturnType<typeof readMarketSnapshot>>;
const snapshot0 = () => snap;

// The 5-seller floor is the policy approved for this page (civitai/civitai#10494).
describe('Creator Studio paid-model market overview', () => {
  beforeAll(async () => {
    snap = await readMarketSnapshot({} as never);
  });

  it('shows a cell with 5 sellers and leaves a 4-seller cell out of every figure', async () => {
    const snapshot = await readMarketSnapshot({} as never);
    const view = marketView(snapshot, {});
    // The 5 Pony versions are in no total, and neither are the draft and the model no site lists, though both
    // share the SDXL cell's price.
    expect(view.paid.versions).toBe(22);
    expect(view.paid.permanent).toBe(17);
    expect(view.paid.early).toBe(5);
    expect(view.histogram.map((b) => b.versions)).toEqual([0, 16, 0, 6, 0, 0]);
    expect(marketView(snapshot, { rating: 'nsfw' }).paid.versions).toBe(5);
    expect(marketView(snapshot, { rating: 'sfw' }).paid.versions).toBe(17);
    // The Pony cell, and the top-band cell that holds one seller.
    expect(snapshot.suppressed.paid).toBe(2);
    expect(marketView(snapshot, { ecosystem: 'Pony' }).paid.versions).toBe(0);
  });

  it('counts a model with versions in two cells once', async () => {
    const view = marketView(await readMarketSnapshot({} as never), {});
    expect(view.paid.models).toBe(21);
  });

  it('counts free generation as free, a model with any paid version as paid, and a draft gate as no gate', async () => {
    const view = marketView(await readMarketSnapshot({} as never), {});
    // 3 free-generation models, 3 ungated (one with two public versions), the one gated only on a draft and the
    // expired window; not the mixed one, and not the 4-seller Checkpoint cell.
    expect(view.free.models).toBe(13);
    expect(view.free.versions).toBe(14);
    expect(view.paidShare).toBeCloseTo(21 / 34);
    expect(marketView(snapshot0(), { rating: 'nsfw' }).free.models).toBe(5);
    expect(marketView(snapshot0(), { rating: 'sfw' }).free.models).toBe(8);
    expect(marketView(snapshot0(), { type: 'Checkpoint' }).free.models).toBe(0);
    expect(snapshot0().suppressed.free).toBe(1);
    expect(marketView(snapshot0(), { access: 'early' }).paidShare).toBeNull();
  });

  it('refuses a snapshot that holds a cell under the floor', async () => {
    const snapshot = await readMarketSnapshot({} as never);
    const [first] = Object.keys(snapshot.cellSellers);
    expect(() =>
      assertFloor({ ...snapshot, cellSellers: { ...snapshot.cellSellers, [first]: 4 } })
    ).toThrow();
  });
});

describe('market overview snapshot reader', () => {
  it('reuses a good snapshot for the TTL, keeps it through a failed fill, and waits before scanning again', async () => {
    let now = 0;
    let calls = 0;
    const good = { builtAt: 'good' } as never;
    const reader = snapshotReader(
      async () => {
        calls++;
        if (calls > 1) throw new Error('fill failed');
        return good;
      },
      () => now
    );
    expect(await reader()).toBe(good);
    now = TTL_MS - 1;
    expect(await reader()).toBe(good);
    expect(calls).toBe(1);
    now = TTL_MS;
    expect(await reader()).toBe(good);
    expect(calls).toBe(2);
    now = TTL_MS + RETRY_AFTER_MS - 1;
    await reader();
    expect(calls).toBe(2);
    now = TTL_MS + RETRY_AFTER_MS;
    await reader();
    expect(calls).toBe(3);
  });

  it('shares one fill between concurrent requests', async () => {
    let calls = 0;
    const reader = snapshotReader(async () => {
      calls++;
      return { builtAt: 'x' } as never;
    });
    await Promise.all([reader(), reader(), reader()]);
    expect(calls).toBe(1);
  });
});

describe('market overview endpoint', () => {
  const call = (handler: ReturnType<typeof marketHandler>) =>
    handler({
      locals: { user: { id: 1 } },
      url: new URL('http://x/analytics/base-models/market'),
    } as never);

  it('answers 404 when the flag is off for the viewer, before reading anything', async () => {
    let reads = 0;
    const handler = marketHandler(
      async () => false,
      async () => (reads++, snapshot0())
    );
    await expect(call(handler)).rejects.toMatchObject({ status: 404 });
    expect(reads).toBe(0);
  });

  it('answers 503 with no snapshot, and the view otherwise', async () => {
    await expect(
      call(
        marketHandler(
          async () => true,
          async () => null
        )
      )
    ).rejects.toMatchObject({ status: 503 });
    const res = (await call(
      marketHandler(
        async () => true,
        async () => snapshot0()
      )
    )) as Response;
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect((await res.json()).paid.versions).toBe(22);
  });
});
