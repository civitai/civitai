import * as dbKysely from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import * as knightsConstants from '@civitai/shared/new-order';
import { servableImage } from '../src/lib/server/servable-image';
import { assertLocalDatabase } from '../src/lib/dev/local-database';

const DEFAULT_COUNT = 50;
const MAX_COUNT = 1000;
const LEVEL_R = 4;

// tsx loads CommonJS-scoped workspace modules as one `default` object when an ES module imports them.
const { KNIGHTS_NSFW_LEVEL_QUESTION } =
  (knightsConstants as { default?: typeof knightsConstants }).default ?? knightsConstants;

async function loadEnqueue() {
  const service = await import('../../../src/server/services/knights/enqueue.service');
  return ((service as { default?: typeof service }).default ?? service).enqueueKnightsItems;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  assertLocalDatabase(connectionString);

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const requested = Number(args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_COUNT);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_COUNT) {
    throw new Error(`Pass a count between 1 and ${MAX_COUNT}.`);
  }

  const { createKyselyClients } = (dbKysely as { default?: typeof dbKysely }).default ?? dbKysely;
  const { db } = createKyselyClients<DB>({
    connectionString,
    sslNoVerify: true,
    singleClient: true,
    max: 1,
  });

  try {
    const images = await db
      .selectFrom('Image as img')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select(['img.id', 'img.nsfwLevel'])
      .where(servableImage)
      .where('img.ingestion', '=', 'Scanned')
      .where('img.nsfwLevelLocked', '=', false)
      .orderBy('img.id', 'desc')
      .limit(requested)
      .execute();

    const enqueueKnightsItems = await loadEnqueue();
    if (dryRun) {
      console.log(`Dry run: ${images.length} eligible images, nothing enqueued.`);
      return;
    }
    const outcomes = await enqueueKnightsItems(db, {
      source: 'dev-backfill',
      questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
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
