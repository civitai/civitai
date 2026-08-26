/**
 * A/B/C/D harness for the challenge review model + judge systemPrompt.
 *
 * Runs the REAL generateReview path (same rubric resolution, same message builders) over a fixed
 * sample of already-judged prod entries, varying only two factors:
 *   prompts: PROD systemPrompt   vs  UPDATED systemPrompt (the pending SQL)
 *   model:   gpt-5-nano          vs  gpt-4o-mini
 *
 * Only systemPrompt differs between the prompt arms: the review path reads systemPrompt +
 * reviewPrompt, and reviewPrompt is untouched. contentPrompt drives article/theme generation.
 *
 * Read-only against prod. Writes nothing back.
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { generateReview } from '~/server/games/daily-challenge/generative-content';
import { challengeJudgingCategoriesSchema } from '~/server/schema/challenge.schema';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { JudgingConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

const OUT_DIR = process.env.AB_OUT_DIR || '/tmp';
const PER_CHALLENGE = Number(process.env.AB_PER_CHALLENGE || 12);
const CONCURRENCY = Number(process.env.AB_CONCURRENCY || 4);
const MODELS = { nano: 'openai/gpt-5-nano', mini: 'openai/gpt-4o-mini' } as const;

function envUrl(key: string) {
  const f = fs.readFileSync(process.env.AB_PG_ENV!, 'utf8');
  const line = f.split('\n').find((l) => l.startsWith(key + '='));
  if (!line) throw new Error(`${key} missing`);
  return line.slice(key.length + 1).trim();
}

type Entry = {
  challengeId: number;
  source: string;
  theme: string;
  themeElements?: string[];
  categories?: { key: string; name: string; criteria: string }[];
  nsfw: boolean;
  judgeId: number;
  imageId: number;
  username: string;
  imageUrl: string;
  liveScore: Record<string, number>;
};

async function loadSample(): Promise<{
  entries: Entry[];
  judgePrompts: Map<number, { system: string; review: string }>;
}> {
  const c = new Client({
    connectionString: envUrl('DATABASE_URL'),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await c.connect();

  const judges = await c.query(
    'SELECT id, "systemPrompt", "reviewPrompt" FROM "ChallengeJudge" ORDER BY id'
  );
  const judgePrompts = new Map<number, { system: string; review: string }>(
    judges.rows.map((r: any) => [r.id, { system: r.systemPrompt, review: r.reviewPrompt }])
  );

  // Recent completed/active challenges spanning System + User and SFW + NSFW, so the sample
  // exercises both the default category set and creator-defined ones, and both rubric variants.
  // Stratified: System (default categories) and User (creator-defined), SFW and NSFW, so the
  // sample exercises both rubric variants and both response-schema shapes.
  const picked = await c.query(`
    WITH eligible AS (
      SELECT c.id, c.source, c.theme, c.metadata, c."judgingCategories", c."allowedNsfwLevel",
             c."judgeId", c."collectionId", (c."allowedNsfwLevel" & 60) > 0 AS is_nsfw
      FROM "Challenge" c
      WHERE c."collectionId" IS NOT NULL AND c.theme IS NOT NULL AND c."startsAt" >= DATE '2026-06-01'
        AND c.id IN (
          SELECT c2.id FROM "Challenge" c2
          JOIN "CollectionItem" ci2 ON ci2."collectionId" = c2."collectionId"
          WHERE ci2.note IS NOT NULL GROUP BY c2.id HAVING count(*) >= 12
        )
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY source, is_nsfw ORDER BY id DESC) AS rn
      FROM eligible
    )
    SELECT id, source, theme, metadata, "judgingCategories", "allowedNsfwLevel", "judgeId", "collectionId"
    FROM ranked WHERE rn <= 2 ORDER BY source, is_nsfw, id DESC`);

  const entries: Entry[] = [];
  for (const ch of picked.rows as any[]) {
    const rows = await c.query(
      `SELECT ci."imageId", i.url, u.username, ci.note
       FROM "CollectionItem" ci
       JOIN "Image" i ON i.id = ci."imageId"
       JOIN "User" u ON u.id = i."userId"
       WHERE ci."collectionId" = $1 AND ci.note IS NOT NULL AND left(btrim(ci.note),1) = '{'
       ORDER BY ci."imageId" LIMIT $2`,
      [ch.collectionId, PER_CHALLENGE]
    );
    const parsed = challengeJudgingCategoriesSchema.safeParse(ch.judgingCategories);
    const categories = parsed.success
      ? parsed.data.map((x) => ({ key: x.key, name: x.label, criteria: x.criteria }))
      : undefined;
    const meta = (ch.metadata ?? {}) as any;
    for (const r of rows.rows as any[]) {
      let liveScore: Record<string, number> = {};
      try {
        liveScore = JSON.parse(r.note)?.score ?? {};
      } catch {
        continue;
      }
      entries.push({
        challengeId: ch.id,
        source: ch.source,
        theme: ch.theme,
        themeElements: Array.isArray(meta.themeElements) ? meta.themeElements : undefined,
        categories,
        nsfw: !getIsSafeBrowsingLevel(ch.allowedNsfwLevel ?? 1),
        judgeId: ch.judgeId ?? 1,
        imageId: r.imageId,
        username: r.username ?? 'unknown',
        imageUrl: getEdgeUrl(r.url, { width: 1200, name: 'image' }),
        liveScore,
      });
    }
  }
  await c.end();
  return { entries, judgePrompts };
}

function makeConfig(system: string, review: string): JudgingConfig {
  return {
    judgeId: 1,
    userId: 2,
    sourceCollectionId: null,
    reviewTemplate: null,
    prompts: {
      systemMessage: system,
      collection: '',
      article: '',
      content: '',
      review,
      winner: '',
    },
  } as JudgingConfig;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function main() {
  const updatedJudges = JSON.parse(fs.readFileSync(process.env.AB_UPDATED_JUDGES!, 'utf8'))
    .rows as any[];
  const updatedById = new Map<number, string>(updatedJudges.map((r) => [r.id, r.systemPrompt]));

  const { entries, judgePrompts } = await loadSample();
  console.log(
    `sample: ${entries.length} entries from ${
      new Set(entries.map((e) => e.challengeId)).size
    } challenges`
  );

  const arms = [
    { arm: 'A prod-prompt + nano', prompts: 'prod', model: MODELS.nano },
    { arm: 'B updated-prompt + nano', prompts: 'updated', model: MODELS.nano },
    { arm: 'C prod-prompt + 4o-mini', prompts: 'prod', model: MODELS.mini },
    { arm: 'D updated-prompt + 4o-mini', prompts: 'updated', model: MODELS.mini },
  ] as const;

  const results: any[] = [];
  for (const a of arms) {
    const t0 = Date.now();
    let fails = 0;
    const rows = await pool(entries, CONCURRENCY, async (e) => {
      const jp = judgePrompts.get(e.judgeId)!;
      const system = a.prompts === 'prod' ? jp.system : updatedById.get(e.judgeId) ?? jp.system;
      try {
        const r = await generateReview({
          theme: e.theme,
          themeElements: e.themeElements,
          creator: e.username,
          imageUrl: e.imageUrl,
          config: makeConfig(system, jp.review),
          categories: e.categories,
          nsfw: e.nsfw,
          model: a.model as any,
        });
        return {
          imageId: e.imageId,
          challengeId: e.challengeId,
          source: e.source,
          score: r.score,
          usage: r.usage,
        };
      } catch (err) {
        fails++;
        return {
          imageId: e.imageId,
          challengeId: e.challengeId,
          source: e.source,
          score: null,
          error: (err as Error).message,
        };
      }
    });
    console.log(`${a.arm}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${fails} failures`);
    results.push({ ...a, rows });
  }

  const payload = { generatedAt: new Date().toISOString(), entries, results };
  fs.writeFileSync(path.join(OUT_DIR, 'judge-model-ab.json'), JSON.stringify(payload, null, 1));
  console.log('wrote', path.join(OUT_DIR, 'judge-model-ab.json'));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
