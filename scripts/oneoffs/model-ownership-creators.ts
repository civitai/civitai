/**
 * Prints the INSERTs that record the creator of each model now owned by the placeholder account, for
 * the "ModelOwnership" backfill. Postgres no longer knows who that was; the analytics store's model
 * Create events do. Reads only, writes nothing: review the output, then apply it by hand after
 * packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/backfill.sql.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/model-ownership-creators.ts > creators.sql
 *
 * Requires DATABASE_URL and the ClickHouse connection from the app's .env.
 */
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';

const CHUNK = 5000;

function creatorInsertsSql(rows: { modelId: number; userId: number }[]): string[] {
  return rows
    .filter((r) => Number.isInteger(r.modelId) && Number.isInteger(r.userId) && r.userId > 0)
    .map(
      (r) =>
        `INSERT INTO "ModelOwnership" ("modelId", "userId", "reason") ` +
        `SELECT ${r.modelId}, ${r.userId}, 'baseline' WHERE NOT EXISTS (` +
        `SELECT 1 FROM "ModelOwnership" WHERE "modelId" = ${r.modelId} AND "userId" = ${r.userId});`
    );
}

async function main() {
  if (!clickhouse) throw new Error('ClickHouse client not initialized');
  const models = await dbRead.model.findMany({
    where: { userId: PLACEHOLDER_OWNER_ID },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  let printed = 0;
  for (let i = 0; i < models.length; i += CHUNK) {
    const ids = models.slice(i, i + CHUNK).map((m) => m.id);
    const rows = await clickhouse.$query<{ modelId: number; userId: number }>(`
      SELECT modelId, any(userId) AS userId
      FROM modelEvents
      WHERE type = 'Create' AND modelId IN (${ids.join(',')}) AND userId > 0
      GROUP BY modelId
    `);
    for (const line of creatorInsertsSql(
      rows.map((r) => ({ modelId: Number(r.modelId), userId: Number(r.userId) }))
    )) {
      console.log(line);
      printed += 1;
    }
  }
  console.error(`${models.length} placeholder-owned models, ${printed} creators found`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => dbRead.$disconnect());
