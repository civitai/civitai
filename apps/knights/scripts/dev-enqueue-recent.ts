import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '@civitai/db-schema/kysely';
import { assertLocalDatabase } from '../src/lib/dev/local-database';

const DEFAULT_COUNT = 50;
const MAX_COUNT = 1000;
const NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';
const LEVEL_R = 4;
const LEVEL_BLOCKED = 32;

// tsx loads the main app's CommonJS-scoped modules as one `default` object when an ES module imports them.
async function loadEnqueue() {
  const service = await import('../../../src/server/services/knights/enqueue.service');
  return ((service as { default?: typeof service }).default ?? service).enqueueKnightsItems;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  assertLocalDatabase(connectionString);

  const requested = Number(process.argv[2] ?? DEFAULT_COUNT);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_COUNT) {
    throw new Error(`Pass a count between 1 and ${MAX_COUNT}.`);
  }

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });

  try {
    const images = await db
      .selectFrom('Image as img')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select(['img.id', 'img.nsfwLevel'])
      .where('img.type', '=', 'image')
      .where('img.ingestion', '=', 'Scanned')
      .where('img.nsfwLevelLocked', '=', false)
      .where('img.blockedFor', 'is', null)
      .where('img.needsReview', 'is', null)
      .where('img.acceptableMinor', '=', false)
      .where('img.nsfwLevel', 'not in', [0, LEVEL_BLOCKED])
      .where('p.publishedAt', 'is not', null)
      .orderBy('img.id', 'desc')
      .limit(requested)
      .execute();

    const enqueueKnightsItems = await loadEnqueue();
    const outcomes = await enqueueKnightsItems(db, {
      source: 'dev-backfill',
      questionKey: NSFW_LEVEL_QUESTION,
      items: images.map((image) => ({
        imageId: image.id,
        priority: image.nsfwLevel >= LEVEL_R ? 2 : 1,
      })),
    });

    const count = (outcome: string) => outcomes.filter((o) => o.outcome === outcome).length;
    console.log(
      `${images.length} eligible images: ${count('enqueued')} enqueued, ${count(
        'duplicate'
      )} already open, ${count('refused')} refused.`
    );
    for (const refused of outcomes) {
      if (refused.outcome === 'refused')
        console.log(`  image ${refused.imageId}: ${refused.reason}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
