/**
 * Can a candidate model drive the CONTENT half of the daily-challenge pipeline?
 *
 * generateArticle is the fragile one: it must return a single JSON object carrying a markdown
 * article body, an invitation, a theme, and a themeElements array. GPT-5 Nano silently returned
 * empty content here (see the playground store's v2->v3 migration), and an empty return breaks
 * challenge creation outright, so a candidate is screened on structural validity before prose.
 *
 * Read-only; writes nothing back.
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import {
  generateArticle,
  generateCollectionDetails,
  generateThemeElements,
  generateWinners,
  generateResourceConcept,
} from '~/server/games/daily-challenge/generative-content';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { JudgingConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

const OUT_DIR = process.env.CC_OUT_DIR || '/tmp';
const MODELS = (process.env.CC_MODELS || 'xiaomi/mimo-v2.5,openai/gpt-4o-mini').split(',');
const SAMPLE = Number(process.env.CC_SAMPLE || 4);

function envUrl(key: string) {
  const f = fs.readFileSync(process.env.CC_PG_ENV!, 'utf8');
  const line = f.split('\n').find((l) => l.startsWith(key + '='));
  if (!line) throw new Error(`${key} missing`);
  return line.slice(key.length + 1).trim();
}

async function main() {
  const c = new Client({
    connectionString: envUrl('DATABASE_URL'),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await c.connect();
  const judge = (
    await c.query(
      'SELECT "systemPrompt","contentPrompt","collectionPrompt","winnerSelectionPrompt","reviewPrompt" FROM "ChallengeJudge" WHERE id = 1'
    )
  ).rows[0];
  const res = await c.query(
    `SELECT DISTINCT ON (m.id) m.id AS "modelId", m.name AS title, m.description,
            u.username AS creator, i.url, mv."trainedWords"
     FROM "Challenge" ch
     JOIN "Model" m ON m.id = (ch.metadata->>'resourceModelId')::int
     JOIN "User" u ON u.id = m."userId"
     JOIN "ModelVersion" mv ON mv."modelId" = m.id AND mv.status = 'Published'
     JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
     JOIN "Image" i ON i."postId" = p.id AND i."nsfwLevel" = 1
     WHERE ch.source = 'System' AND ch."startsAt" >= DATE '2026-07-01'
     ORDER BY m.id, ch.id DESC LIMIT $1`,
    [SAMPLE]
  );
  await c.end();

  const config = {
    judgeId: 1,
    userId: 2,
    sourceCollectionId: null,
    reviewTemplate: null,
    prompts: {
      systemMessage: judge.systemPrompt,
      collection: judge.collectionPrompt,
      article: '',
      content: judge.contentPrompt,
      review: judge.reviewPrompt,
      winner: judge.winnerSelectionPrompt,
    },
  } as JudgingConfig;

  const prizeConfig = {
    prizes: [
      { buzz: 5000, points: 100 },
      { buzz: 2500, points: 50 },
      { buzz: 1000, points: 25 },
    ],
    entryPrize: { buzz: 200, points: 10 },
    entryPrizeRequirement: 5,
  };
  const entries = [
    { creatorId: 11, creator: 'alpha', summary: 'a bright tagine still life', score: { theme: 9 } },
    { creatorId: 22, creator: 'bravo', summary: 'moody clay pot scene', score: { theme: 8 } },
    { creatorId: 33, creator: 'charlie', summary: 'busy market stall', score: { theme: 7 } },
    { creatorId: 44, creator: 'delta', summary: 'minimal ceramic study', score: { theme: 7 } },
  ];

  const out: any[] = [];
  for (const model of MODELS) {
    const per: any = { model, article: [], other: {} };
    for (const r of res.rows as any[]) {
      const image = { id: 0, url: getEdgeUrl(r.url, { width: 1200, name: 'cover' }) };
      const resource = {
        modelId: r.modelId,
        title: r.title,
        creator: r.creator,
        description: r.description,
        trainedWords: r.trainedWords,
      };
      const t0 = Date.now();
      try {
        const concept = await generateResourceConcept({
          resource,
          images: [image],
          config,
          model: model as any,
        });
        const a = await generateArticle({
          resource,
          resourceConcept: concept,
          image,
          challengeDate: new Date(),
          ...prizeConfig,
          allowedNsfwLevel: 1,
          config,
          model: model as any,
        });
        per.article.push({
          title: r.title,
          ms: Date.now() - t0,
          concept,
          ok: true,
          got: {
            title: a.title,
            theme: a.theme,
            themeElements: a.themeElements,
            invitationLen: (a.invitation || '').length,
            contentLen: (a.content || '').length,
            contentHtml: (a.content || '').slice(0, 160),
          },
        });
      } catch (e) {
        per.article.push({
          title: r.title,
          ms: Date.now() - t0,
          ok: false,
          error: (e as Error).message,
        });
      }
    }
    for (const [name, fn] of [
      [
        'collection',
        () =>
          generateCollectionDetails({
            resource: {
              modelId: (res.rows[0] as any).modelId,
              title: (res.rows[0] as any).title,
              creator: (res.rows[0] as any).creator,
            },
            image: {
              id: 0,
              url: getEdgeUrl((res.rows[0] as any).url, { width: 1200, name: 'cover' }),
            },
            config,
            model: model as any,
          }),
      ],
      [
        'themeElements',
        () =>
          generateThemeElements({
            theme: 'Clay and Spice',
            resourceConcept: 'Moroccan clay tagine cookware',
            config,
            model: model as any,
          }),
      ],
      [
        'winners',
        () =>
          generateWinners({
            entries: entries as any,
            theme: 'Clay and Spice',
            config,
            model: model as any,
          }),
      ],
    ] as const) {
      try {
        per.other[name] = { ok: true, value: await (fn as any)() };
      } catch (e) {
        per.other[name] = { ok: false, error: (e as Error).message };
      }
    }
    const okA = per.article.filter((x: any) => x.ok).length;
    console.log(
      `${model}: article ${okA}/${per.article.length} ok | ` +
        Object.entries(per.other)
          .map(([k, v]: any) => `${k}:${v.ok ? 'ok' : 'FAIL'}`)
          .join(' ')
    );
    out.push(per);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'judge-content-check.json'), JSON.stringify(out, null, 1));
  console.log('wrote', path.join(OUT_DIR, 'judge-content-check.json'));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
