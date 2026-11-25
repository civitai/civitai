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

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { readMarketSnapshot } = await import('../market-overview');
const { marketView } = await import('$lib/analytics/market-overview');

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

describe('Creator Studio paid-model market overview', () => {
  it('shows a cell with 5 sellers and leaves a 4-seller cell out of every figure', async () => {
    const snapshot = await readMarketSnapshot({} as never);
    const view = marketView(snapshot, {});
    // 6 SDXL download-priced + 6 generation-only versions. The 5 Pony versions are in no total, and neither are the
    // draft and the model no site lists, though both share the SDXL cell's price.
    expect(view.paid.versions).toBe(12);
    expect(view.paid.permanent).toBe(12);
    expect(view.histogram.map((b) => b.versions)).toEqual([0, 6, 0, 6, 0, 0]);
    // The Pony cell, and the top-band cell that holds one seller.
    expect(snapshot.suppressed.paid).toBe(2);
    expect(marketView(snapshot, { ecosystem: 'Pony' }).paid.versions).toBe(0);
  });

  it('counts a model with versions in two cells once', async () => {
    const view = marketView(await readMarketSnapshot({} as never), {});
    expect(view.paid.models).toBe(11);
  });

  it('counts free generation as free, a model with any paid version as paid, and a draft gate as no gate', async () => {
    const view = marketView(await readMarketSnapshot({} as never), {});
    // 3 free-generation models, 2 ungated, and the one gated only on a draft; not the mixed one.
    expect(view.free.models).toBe(6);
    expect(view.free.versions).toBe(6);
    expect(view.paidShare).toBeCloseTo(11 / 17);
  });
});
