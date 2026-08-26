/**
 * Is gpt-4o-mini usable for reviewing NSFW challenge entries?
 *
 * Runs the REAL generateReview path over explicit entries (image nsfwLevel R/X/XXX) drawn from
 * live NSFW challenges, across three review models, with production judge prompts. Grok is the
 * reference arm because it is what the pipeline moved TO for NSFW quality.
 *
 * Measures the two things that decide usability: refusal rate, and whether the review text is
 * substantive rather than sanitised boilerplate. Read-only; writes nothing back.
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { generateReview } from '~/server/games/daily-challenge/generative-content';
import { challengeJudgingCategoriesSchema } from '~/server/schema/challenge.schema';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { JudgingConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

const OUT_DIR = process.env.NS_OUT_DIR || '/tmp';
const SAMPLE = Number(process.env.NS_SAMPLE || 24);
const CONCURRENCY = Number(process.env.NS_CONCURRENCY || 6);

const DEFAULT_ARMS = ['openai/gpt-5-nano', 'openai/gpt-4o-mini', 'x-ai/grok-4.3'];
const ARMS = (process.env.NS_MODELS ? process.env.NS_MODELS.split(',') : DEFAULT_ARMS).map((m) => ({
  arm: m.trim(),
  model: m.trim(),
}));

function envUrl(key: string) {
  const f = fs.readFileSync(process.env.NS_PG_ENV!, 'utf8');
  const line = f.split('\n').find((l) => l.startsWith(key + '='));
  if (!line) throw new Error(`${key} missing`);
  return line.slice(key.length + 1).trim();
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function main() {
  const c = new Client({
    connectionString: envUrl('DATABASE_URL'),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await c.connect();

  const judges = new Map<number, { system: string; review: string }>(
    (await c.query('SELECT id, "systemPrompt", "reviewPrompt" FROM "ChallengeJudge"')).rows.map(
      (r: any) => [r.id, { system: r.systemPrompt, review: r.reviewPrompt }]
    )
  );

  // Explicit entries only, spread across challenges and both judges, hardest levels first.
  const rows = await c.query(
    `SELECT DISTINCT ON (c.id, i."nsfwLevel")
        c.id AS "challengeId", c.theme, c.metadata, c."judgingCategories", c."judgeId",
        i.id AS "imageId", i.url, i."nsfwLevel", u.username
     FROM "Challenge" c
     JOIN "CollectionItem" ci ON ci."collectionId" = c."collectionId"
     JOIN "Image" i ON i.id = ci."imageId"
     JOIN "User" u ON u.id = i."userId"
     WHERE (c."allowedNsfwLevel" & 60) > 0 AND ci.note IS NOT NULL
       AND i."nsfwLevel" IN (4, 8, 16) AND c.theme IS NOT NULL
     ORDER BY c.id DESC, i."nsfwLevel" DESC, i.id
     LIMIT $1`,
    [SAMPLE]
  );
  await c.end();

  const entries = rows.rows.map((r: any) => {
    const parsed = challengeJudgingCategoriesSchema.safeParse(r.judgingCategories);
    const meta = (r.metadata ?? {}) as any;
    return {
      challengeId: r.challengeId,
      imageId: r.imageId,
      nsfwLevel: r.nsfwLevel,
      judgeId: r.judgeId ?? 1,
      theme: r.theme,
      themeElements: Array.isArray(meta.themeElements) ? meta.themeElements : undefined,
      categories: parsed.success
        ? parsed.data.map((x) => ({ key: x.key, name: x.label, criteria: x.criteria }))
        : undefined,
      username: r.username ?? 'unknown',
      imageUrl: getEdgeUrl(r.url, { width: 1200, name: 'image' }),
    };
  });
  const byLevel = entries.reduce(
    (a: any, e) => ((a[e.nsfwLevel] = (a[e.nsfwLevel] || 0) + 1), a),
    {}
  );
  console.log(`sample: ${entries.length} explicit entries; by nsfwLevel:`, byLevel);

  const results: any[] = [];
  for (const a of ARMS) {
    const t0 = Date.now();
    const out = await pool(entries, CONCURRENCY, async (e) => {
      const jp = judges.get(e.judgeId)!;
      const config = {
        judgeId: 1,
        userId: 2,
        sourceCollectionId: null,
        reviewTemplate: null,
        prompts: {
          systemMessage: jp.system,
          collection: '',
          article: '',
          content: '',
          review: jp.review,
          winner: '',
        },
      } as JudgingConfig;
      try {
        const r = await generateReview({
          theme: e.theme,
          themeElements: e.themeElements,
          creator: e.username,
          imageUrl: e.imageUrl,
          config,
          categories: e.categories,
          nsfw: true,
          model: a.model as any,
        });
        return {
          imageId: e.imageId,
          nsfwLevel: e.nsfwLevel,
          score: r.score,
          comment: r.comment,
          summary: r.summary,
          reaction: r.reaction,
          usage: r.usage,
        };
      } catch (err) {
        return {
          imageId: e.imageId,
          nsfwLevel: e.nsfwLevel,
          score: null,
          error: (err as Error).message,
        };
      }
    });
    const refused = out.filter((r: any) => !r.score).length;
    console.log(
      `${a.arm}: ${((Date.now() - t0) / 1000).toFixed(0)}s, ${refused}/${entries.length} refused`
    );
    results.push({ ...a, rows: out });
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'judge-nsfw-check.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), entries, results }, null, 1)
  );
  console.log('wrote', path.join(OUT_DIR, 'judge-nsfw-check.json'));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
