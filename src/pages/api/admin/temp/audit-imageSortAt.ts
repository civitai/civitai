import { Prisma } from '@prisma/client';
import type { NextApiRequest } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * PG ↔ BitDex sortAt reconcile.
 *
 * Samples images, computes the PG-authored sort key for each, fetches the BitDex
 * document, and compares. Stood up BEFORE cutover so the instrument is proven to
 * fire on a seeded mismatch; usable both pre- and post-cutover.
 *
 * The compared value on both sides is SECONDS:
 *   - PG:     EXTRACT(EPOCH FROM GREATEST(p."publishedAt", i."scannedAt",
 *             i."createdAt"))::bigint  — the exact trigger formula (PR #3168),
 *             LEFT JOIN so draft/postless images collapse to GREATEST(scannedAt,
 *             createdAt).
 *   - BitDex: the `sortAt` doc field, stored in seconds
 *             (civitai-index.yaml: `sortAtUnix -> sortAt, ms_to_seconds: true`).
 *
 * Modes (interpretation only — raw counts are always reported):
 *   - mode=pre  (default): BitDex sortAt is still ENGINE-COMPUTED as
 *     GREATEST(existedAt, publishedAt), where existedAt = GREATEST(scannedAt,
 *     createdAt). That is MATHEMATICALLY IDENTICAL to the trigger formula, so a
 *     correctly-recomputed engine value MATCHES. Pre-cutover mismatches therefore
 *     do NOT come from a formula difference; they come from two known classes:
 *       (a) DOMINANT — the engine silently fails to fold a delivered publishedAt
 *           into sortAt on ~7-28% of recent publishes (W1-4 specimens,
 *           docs/_in/sortat-divergence-specimens-2026-07-16.md), leaving sortAt
 *           stuck at existedAt. These are exactly the rows ingestion fixes.
 *       (b) the scheduled / future-publishedAt head (quarantined, isPublished=
 *           false) whose engine sortAt has not crossed Tf.
 *     A clean-ish recent-window baseline is NOT a broken instrument — it means the
 *     recompute happened to succeed on the sample; mismatches concentrate in
 *     class (a). Pre-cutover this run measures that divergence + proves the fetch/
 *     compare path works; it is NOT a pass/fail gate.
 *   - mode=post: BitDex sortAt is INGESTED from the trigger value. Any mismatch is
 *     a real drift; `ok` is false if mismatches > 0.
 *
 * Populations sampled (N each):
 *   - recent:  images on posts published within `lookbackHours` (the hot head
 *              where drift matters most and where the W1-4 misorder class lived).
 *   - overall: random ids across the whole table.
 *
 * Seeded-mismatch proof (`seedMismatch=true`): the FIRST specimen's EXPECTED
 * value is deliberately corrupted IN MEMORY before comparison. It MUST then read
 * as a mismatch. This proves the alarm can fire. It NEVER writes to Image.
 *
 * Trigger:
 *   /api/admin/temp/audit-imageSortAt?token=$WEBHOOK_TOKEN&mode=pre&n=200
 *   ...&mode=post                              (post-cutover: mismatch => ok:false)
 *   ...&seedMismatch=true                      (prove the alarm fires)
 */

const BITDEX_URL = process.env.BITDEX_URL || '';
const INDEX = 'civitai';

const schema = z.object({
  mode: z.enum(['pre', 'post']).default('pre'),
  n: z.coerce.number().min(1).max(5000).default(200),
  lookbackHours: z.coerce.number().min(1).max(24 * 30).default(48),
  // Exact-second equality is expected; ±tolerance absorbs ms→s truncation noise.
  toleranceSecs: z.coerce.number().min(0).max(60).default(1),
  // How many mismatch specimens to include in the response body.
  specimenLimit: z.coerce.number().min(0).max(500).default(50),
  seedMismatch: booleanString().default(false),
});

type Sampled = {
  id: number;
  formulaSecs: number | null;
  publishedAt: Date | null;
  scannedAt: Date | null;
  createdAt: Date;
  population: 'recent' | 'overall';
};

type Verdict = {
  id: number;
  population: 'recent' | 'overall';
  pgSecs: number | null;
  bitdexSecs: number | null;
  deltaSecs: number | null;
  status: 'match' | 'mismatch' | 'missing' | 'fetch_error';
  seeded?: boolean;
};

export default WebhookEndpoint(async (req, res) => {
  if (!BITDEX_URL) {
    res.status(500).json({ error: 'BITDEX_URL not configured' });
    return;
  }
  const result = await audit(req);
  res.status(200).json(result);
});

async function audit(req: NextApiRequest) {
  const params = schema.parse(req.query);

  const recent = await sampleRecent(params.n, params.lookbackHours);
  const overall = await sampleOverall(params.n);
  const sampled = [...recent, ...overall];

  const bitdexById = await fetchBitdexSortAt(sampled.map((s) => s.id));

  const verdicts: Verdict[] = sampled.map((s, idx) => {
    // Seeded proof: corrupt the FIRST specimen's expected value in memory only.
    const seeded = params.seedMismatch && idx === 0;
    const pgSecs = s.formulaSecs == null ? null : seeded ? s.formulaSecs + 999_999 : s.formulaSecs;

    const bd = bitdexById.get(s.id);
    if (bd === undefined) {
      // No entry returned at all — treat as a fetch gap, not a data mismatch.
      return { id: s.id, population: s.population, pgSecs, bitdexSecs: null, deltaSecs: null, status: 'fetch_error', ...(seeded ? { seeded } : {}) };
    }
    if (bd === null) {
      // Doc exists but has no sortAt yet (pre-ingest). Not a drift.
      return { id: s.id, population: s.population, pgSecs, bitdexSecs: null, deltaSecs: null, status: 'missing', ...(seeded ? { seeded } : {}) };
    }
    if (pgSecs == null) {
      return { id: s.id, population: s.population, pgSecs: null, bitdexSecs: bd, deltaSecs: null, status: 'mismatch', ...(seeded ? { seeded } : {}) };
    }
    const delta = bd - pgSecs;
    const status = Math.abs(delta) <= params.toleranceSecs ? 'match' : 'mismatch';
    return { id: s.id, population: s.population, pgSecs, bitdexSecs: bd, deltaSecs: delta, status, ...(seeded ? { seeded } : {}) };
  });

  const counts = tally(verdicts);
  const mismatches = verdicts.filter((v) => v.status === 'mismatch');

  // Prove the seeded specimen actually flipped the alarm.
  const seededSpecimen = verdicts.find((v) => v.seeded);
  const seedProven = params.seedMismatch ? seededSpecimen?.status === 'mismatch' : undefined;

  const ok =
    (params.mode === 'post' ? counts.mismatch === 0 : true) &&
    counts.fetch_error === 0 &&
    (params.seedMismatch ? seedProven === true : true);

  return {
    ok,
    mode: params.mode,
    sampled: sampled.length,
    counts,
    seedMismatch: params.seedMismatch,
    seedProven,
    note:
      params.mode === 'pre'
        ? 'pre-cutover: engine sortAt = GREATEST(existedAt, publishedAt) is formula-identical to the trigger; mismatches are the engine recompute-failure class (~7-28% of recent publishes, sortAt stuck at existedAt) + the scheduled future-publishedAt head, not failures of this audit.'
        : 'post-cutover: BitDex sortAt is ingested; any mismatch is real drift.',
    specimens: mismatches.slice(0, params.specimenLimit),
  };
}

function tally(verdicts: Verdict[]) {
  const c = { match: 0, mismatch: 0, missing: 0, fetch_error: 0 };
  for (const v of verdicts) c[v.status]++;
  return c;
}

// --- sampling -------------------------------------------------------------

async function sampleRecent(n: number, lookbackHours: number): Promise<Sampled[]> {
  const rows = await dbRead.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT i.id,
           EXTRACT(EPOCH FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt"))::bigint AS formula_secs,
           p."publishedAt", i."scannedAt", i."createdAt"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE p."publishedAt" > now() - (${lookbackHours} * interval '1 hour')
      AND p."publishedAt" <= now()
    ORDER BY random()
    LIMIT ${n}
  `);
  return rows.map((r) => toSampled(r, 'recent'));
}

async function sampleOverall(n: number): Promise<Sampled[]> {
  // Random ids across [min,max]; LATERAL grabs the nearest existing row per pick.
  // Cheap (index scans), unlike ORDER BY random() over the full table.
  const rows = await dbRead.$queryRaw<RawRow[]>(Prisma.sql`
    WITH bounds AS (SELECT MIN(id) AS lo, MAX(id) AS hi FROM "Image"),
    picks AS (
      SELECT (b.lo + floor(random() * (b.hi - b.lo)))::int AS rid
      FROM bounds b, generate_series(1, ${n})
    )
    SELECT i.id,
           EXTRACT(EPOCH FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt"))::bigint AS formula_secs,
           p."publishedAt", i."scannedAt", i."createdAt"
    FROM picks
    JOIN LATERAL (
      SELECT * FROM "Image" im WHERE im.id >= picks.rid ORDER BY im.id LIMIT 1
    ) i ON true
    LEFT JOIN "Post" p ON p.id = i."postId"
  `);
  // DISTINCT by id (random picks can collide near the top of the range).
  const seen = new Set<number>();
  return rows
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map((r) => toSampled(r, 'overall'));
}

type RawRow = {
  id: number;
  // int8/bigint: node-pg returns it as a string; Number() normalizes.
  formula_secs: string | number | null;
  publishedAt: Date | null;
  scannedAt: Date | null;
  createdAt: Date;
};

function toSampled(r: RawRow, population: 'recent' | 'overall'): Sampled {
  return {
    id: r.id,
    formulaSecs: r.formula_secs == null ? null : Number(r.formula_secs),
    publishedAt: r.publishedAt,
    scannedAt: r.scannedAt,
    createdAt: r.createdAt,
    population,
  };
}

// --- BitDex fetch ---------------------------------------------------------

/**
 * Returns a map slot_id -> sortAt seconds. Value is `null` when the doc exists
 * but carries no sortAt; the id is ABSENT from the map when the fetch itself
 * failed (so callers can tell "not ingested" from "couldn't ask").
 */
async function fetchBitdexSortAt(ids: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${BITDEX_URL}/api/indexes/${INDEX}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_ids: slice, fields: ['sortAt'] }),
      });
      if (!res.ok) {
        console.error(`[sortAt-audit] BitDex fetch ${res.status}`);
        continue; // leave this slice's ids absent → fetch_error
      }
      const json = (await res.json()) as { documents?: { id: number; sortAt?: number }[] };
      for (const doc of json.documents ?? []) {
        out.set(doc.id, typeof doc.sortAt === 'number' ? doc.sortAt : null);
      }
    } catch (e) {
      console.error('[sortAt-audit] BitDex fetch error', (e as Error).message);
      // leave absent → fetch_error
    }
  }
  return out;
}
