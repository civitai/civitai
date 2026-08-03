/**
 * Deletes CollectionItem rows whose referenced entity no longer exists, then optionally adds the
 * foreign keys that schema.prisma has always declared but the database never had.
 *
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs count
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs clean [--apply] [--only imageId]
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs constrain [--apply] [--only imageId]
 *
 * Without --apply nothing is written. `constrain` refuses to run while orphans remain, because
 * VALIDATE would fail on them.
 */
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const RELATIONS = [
  { column: 'imageId', table: 'Image' },
  { column: 'postId', table: 'Post' },
  { column: 'articleId', table: 'Article' },
  { column: 'modelId', table: 'Model' },
];

// Small enough that each statement stays short and the WAL burst stays modest on a ~210M row table.
const BATCH_SIZE = 5000;

const args = process.argv.slice(2);
const command = args[0];
const apply = args.includes('--apply');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];

const relations = only ? RELATIONS.filter((r) => r.column === only) : RELATIONS;
if (!relations.length) throw new Error(`Unknown relation: ${only}`);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 30 * 60 * 1000,
});

const orphanCount = async ({ column, table }) => {
  const { rows } = await client.query(
    `SELECT count(*)::int n FROM "CollectionItem" ci
      WHERE ci."${column}" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x.id = ci."${column}")`
  );
  return rows[0].n;
};

async function count() {
  let total = 0;
  for (const relation of relations) {
    const n = await orphanCount(relation);
    total += n;
    console.log(`${relation.column.padEnd(10)} ${n}`);
  }
  console.log(`total      ${total}`);
  return total;
}

async function clean() {
  for (const { column, table } of relations) {
    const before = await orphanCount({ column, table });
    if (!before) {
      console.log(`${column}: already clean`);
      continue;
    }
    if (!apply) {
      console.log(`${column}: ${before} orphans (dry run, pass --apply to delete)`);
      continue;
    }

    // Collected once into a temp table: the anti-join is a full scan, and re-running it per batch
    // would cost minutes each time.
    await client.query(`DROP TABLE IF EXISTS orphan_ids`);
    await client.query(
      `CREATE TEMP TABLE orphan_ids AS
         SELECT ci.id FROM "CollectionItem" ci
          WHERE ci."${column}" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x.id = ci."${column}")`
    );
    await client.query(`CREATE INDEX ON orphan_ids (id)`);

    let deleted = 0;
    for (;;) {
      const { rowCount } = await client.query(
        `DELETE FROM "CollectionItem"
          WHERE id IN (SELECT id FROM orphan_ids ORDER BY id LIMIT ${BATCH_SIZE})`
      );
      if (!rowCount) break;
      await client.query(
        `DELETE FROM orphan_ids WHERE id IN (
           SELECT id FROM orphan_ids ORDER BY id LIMIT ${BATCH_SIZE})`
      );
      deleted += rowCount;
      process.stdout.write(`\r  ${column}: deleted ${deleted}/${before}`);
    }
    await client.query(`DROP TABLE IF EXISTS orphan_ids`);
    console.log(`\r  ${column}: deleted ${deleted}/${before}   `);
  }
}

async function constrain() {
  for (const { column, table } of relations) {
    const name = `CollectionItem_${column}_fkey`;
    const { rows: existing } = await client.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
      [name]
    );

    if (existing.length && existing[0].convalidated) {
      console.log(`${column}: ${name} already present and valid`);
      continue;
    }

    const orphans = await orphanCount({ column, table });
    if (orphans) {
      console.log(`${column}: ${orphans} orphans remain — run clean --apply first, skipping`);
      continue;
    }

    if (!apply) {
      console.log(`${column}: would add ${name} (dry run)`);
      continue;
    }

    if (!existing.length) {
      // NOT VALID keeps this to a brief ACCESS EXCLUSIVE lock with no table scan.
      await client.query(
        `ALTER TABLE "CollectionItem" ADD CONSTRAINT "${name}"
           FOREIGN KEY ("${column}") REFERENCES "${table}"(id)
           ON UPDATE CASCADE ON DELETE CASCADE NOT VALID`
      );
      console.log(`${column}: added ${name} (NOT VALID)`);
    }

    // SHARE UPDATE EXCLUSIVE — reads and writes continue during the scan.
    const started = Date.now();
    await client.query(`ALTER TABLE "CollectionItem" VALIDATE CONSTRAINT "${name}"`);
    console.log(`${column}: validated in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}

const commands = { count, clean, constrain };
if (!commands[command]) {
  console.error('usage: cleanup-collection-item-orphans.mjs <count|clean|constrain> [--apply] [--only <column>]');
  process.exit(1);
}

await client.connect();
try {
  await commands[command]();
} finally {
  await client.end();
}
