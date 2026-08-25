/**
 * Stratified sampler for TEXT-MODE ENTITIES — the counterpart of `sample-core.ts`, which does the
 * same job for generation prompts.
 *
 *   pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/xguard-lab/sample-entities.ts \
 *     --entity Model --batch models-2026-08-25-young --label Young --size 60
 *
 * Every entity that flows through `EntityModeration` in text mode is sampleable the same way, and
 * Model is not the biggest of them. Anything model-shaped here is in `ENTITY_TEXT` and nowhere
 * else.
 *
 * `sample-core.ts` stratifies generation prompts on the live scores ClickHouse keeps in
 * `orchestration.xguardPromptResults`. Text-mode entities have their own store of exactly the same
 * thing: `EntityModeration.result` holds every label's score from the scans already run, so a batch
 * can be stratified without spending one new model call.
 *
 * Why stratify rather than take the newest N: a label's scores are rarely spread evenly across
 * live content, and different labels skew in opposite directions. A uniform sample of a skewed
 * label is almost entirely one-sided and says nothing about where the boundary sits — which is
 * the whole question a reviewer is being asked to answer.
 */
import pg from 'pg';

export type EntitySampleOptions = {
  /** Which text-mode entity to sample. Its scanned string comes from `ENTITY_TEXT`. */
  entity: EntityKey;
  /** Lab database (MODERATOR_DATABASE_URL). */
  connectionString: string;
  /** Main database, read-only (DATABASE_REPLICA_URL). */
  sourceConnectionString: string;
  batch: string;
  label: string;
  size?: number;
  bands?: number;
  /**
   * Minimum description length. A bare model name gives a reviewer nothing to judge, and a corpus
   * of them measures "can you identify content from 15 characters" rather than the label.
   * `bareNameShare` deliberately keeps some anyway — see below.
   */
  minDescription?: number;
  /**
   * Fraction of the batch reserved for listings with little or no description. They are a
   * substantial share of live content, so excluding them entirely would tune a label against a
   * population it does not meet in production. Kept as a bounded minority rather than left to
   * dominate the batch.
   */
  bareNameShare?: number;
};

export type EntitySampleSummary = {
  entity: EntityKey;
  batch: string;
  label: string;
  bands: { lo: number; hi: number; rows: number }[];
  bareNames: number;
  candidates: number;
  inserted: number;
  duplicates: number;
};

// Identifiers reach SQL as parameters everywhere except the label, which is compared inside a
// jsonb path — refuse anything that is not a plain label name rather than trying to escape it.
const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/**
 * How each entity's scanned string is built, and the ONLY entity-shaped thing in this file.
 *
 * Each entry MUST match that entity's `resolveContent` in its production adapter — the string the
 * scanner actually sees. Model is `model-moderation.adapter.ts`, Article is
 * `article-moderation.adapter.ts`. Copied rather than imported because this runs under
 * `tsconfig.scripts.json` and importing from the Next.js app would pull its whole module graph in.
 *
 * If a copy drifts, reviewers judge text the scanner never sees and every number measured here
 * describes a scan that never happened. Change one, change the other.
 *
 * Challenge and WildcardSetCategory are deliberately absent. Challenge composes six fields through
 * `buildChallengeModerationText` and Wildcard is a newline-joined word list rather than prose —
 * neither is a title+body pair, and inventing a resolver that merely looks right is exactly the
 * drift this comment warns about. Add them by reading their adapter, not by guessing.
 */
export const ENTITY_TEXT = {
  Model: { table: 'Model', title: 'name', body: 'description' },
  Article: { table: 'Article', title: 'title', body: 'content' },
} as const;

export type EntityKey = keyof typeof ENTITY_TEXT;

/** `[title, body-with-tags-stripped]`, whitespace collapsed — the shape both adapters produce. */
export function buildEntityText(title: string, body: string | null): string {
  return [title, body ? body.replace(/<[^>]*>/g, ' ') : null]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Candidate = {
  id: number;
  title: string;
  body: string | null;
  scores: Record<string, number>;
};

export async function sampleEntityBatch(opts: EntitySampleOptions): Promise<EntitySampleSummary> {
  const { batch, label, entity } = opts;
  const shape = ENTITY_TEXT[entity];
  if (!shape)
    throw new Error(`unknown entity "${entity}" — add it to ENTITY_TEXT after reading its adapter`);
  if (!LABEL_PATTERN.test(label)) throw new Error(`invalid label "${label}"`);
  const size = Math.trunc(opts.size ?? 60);
  const bandCount = Math.trunc(opts.bands ?? 5);
  const minDescription = Math.trunc(opts.minDescription ?? 120);
  const bareNameShare = opts.bareNameShare ?? 0.15;
  if (size < 1) throw new Error('size must be at least 1');
  if (bandCount < 1) throw new Error('bands must be at least 1');

  const bareTarget = Math.round(size * bareNameShare);
  const perBand = Math.max(1, Math.floor((size - bareTarget) / bandCount));

  const source = new pg.Client({ connectionString: opts.sourceConnectionString });
  await source.connect();

  const rows: Candidate[] = [];
  const bands: EntitySampleSummary['bands'] = [];
  try {
    // One query per band. Same reasoning as the prompt sampler: a short band stays visible instead
    // of being silently rebalanced into its neighbours.
    for (let b = 0; b < bandCount; b++) {
      const lo = b / bandCount;
      const hi = (b + 1) / bandCount;
      const { rows: band } = await source.query<Candidate>(
        `
        WITH scored AS (
          SELECT em."entityId" AS id,
                 jsonb_object_agg(x->>'label', (x->>'score')::float) AS scores,
                 max((x->>'score')::float) FILTER (WHERE lower(x->>'label') = lower($1)) AS band_score
            FROM "EntityModeration" em
            CROSS JOIN LATERAL jsonb_array_elements(em.result->'results') AS x
           WHERE em."entityType" = $6 AND em.status = 'Succeeded' AND em.result IS NOT NULL
           GROUP BY em."entityId"
        )
        SELECT e.id, e."${shape.title}" AS title, e."${shape.body}" AS body, s.scores
          FROM scored s
          JOIN "${shape.table}" e ON e.id = s.id
         WHERE e.status = 'Published'
           AND length(coalesce(e."${shape.body}", '')) >= $2
           AND s.band_score >= $3 AND s.band_score < $4
         ORDER BY md5(e.id::text)
         LIMIT $5`,
        [label, minDescription, lo, b === bandCount - 1 ? 1.01 : hi, perBand, entity]
      );
      bands.push({ lo, hi, rows: band.length });
      rows.push(...band);
    }

    // The deliberate bare-name minority.
    const { rows: bare } = await source.query<Candidate>(
      `
      WITH scored AS (
        SELECT em."entityId" AS id,
               jsonb_object_agg(x->>'label', (x->>'score')::float) AS scores
          FROM "EntityModeration" em
          CROSS JOIN LATERAL jsonb_array_elements(em.result->'results') AS x
         WHERE em."entityType" = $3 AND em.status = 'Succeeded' AND em.result IS NOT NULL
         GROUP BY em."entityId"
      )
      SELECT e.id, e."${shape.title}" AS title, e."${shape.body}" AS body, s.scores
        FROM scored s
        JOIN "${shape.table}" e ON e.id = s.id
       WHERE e.status = 'Published'
         AND length(coalesce(e."${shape.body}", '')) < $1
       ORDER BY md5(e.id::text)
       LIMIT $2`,
      [minDescription, bareTarget, entity]
    );
    rows.push(...bare);

    const seen = new Set<number>();
    const unique = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));

    const lab = new pg.Client({ connectionString: opts.connectionString });
    await lab.connect();
    try {
      let inserted = 0;
      for (const r of unique) {
        const text = buildEntityText(r.title, r.body);
        if (!text) continue;
        const res = await lab.query(
          `INSERT INTO sample (prompt_hash, source, batch, positive_prompt, live_scores)
           VALUES ($1, 'model', $2, $3, $4)
           ON CONFLICT (batch, prompt_hash) DO NOTHING`,
          [r.id, batch, text, JSON.stringify(r.scores)]
        );
        inserted += res.rowCount ?? 0;
      }
      return {
        entity,
        batch,
        label,
        bands,
        bareNames: bare.length,
        candidates: unique.length,
        inserted,
        duplicates: unique.length - inserted,
      };
    } finally {
      await lab.end();
    }
  } finally {
    await source.end();
  }
}

// CLI. Kept thin on purpose: the logic above is what an API endpoint would call.
async function main() {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  const label = get('--label');
  const entity = (get('--entity') ?? 'Model') as EntityKey;
  if (!batch) throw new Error('--batch is required');
  if (!label) throw new Error('--label is required');
  if (!ENTITY_TEXT[entity])
    throw new Error(`--entity must be one of: ${Object.keys(ENTITY_TEXT).join(', ')}`);

  const summary = await sampleEntityBatch({
    entity,
    connectionString: get('--lab-db') ?? process.env.MODERATOR_DATABASE_URL ?? '',
    sourceConnectionString:
      get('--source-db') ?? process.env.DATABASE_REPLICA_URL ?? process.env.DATABASE_URL ?? '',
    batch,
    label,
    size: get('--size') ? Number(get('--size')) : undefined,
    bands: get('--bands') ? Number(get('--bands')) : undefined,
    minDescription: get('--min-description') ? Number(get('--min-description')) : undefined,
  });

  console.log(`${summary.entity} / ${summary.label} -> ${summary.batch}`);
  for (const b of summary.bands) console.log(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${b.rows}`);
  console.log(`  bare names  ${summary.bareNames}`);
  console.log(`  ${summary.inserted} inserted, ${summary.duplicates} already present`);
}

// Only run when invoked directly, so the API can import `sampleEntityBatch` without side effects.
if (process.argv[1]?.endsWith('sample-entities.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
