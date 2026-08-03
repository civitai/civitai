/**
 * Deletes CollectionItem rows whose referenced entity no longer exists, then optionally adds the
 * foreign keys that schema.prisma has always declared but the database never had.
 *
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs count
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs backup
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs clean [--apply] [--only imageId]
 *   node scripts/oneoffs/cleanup-collection-item-orphans.mjs constrain [--apply] [--only imageId]
 *
 * Without --apply nothing is written. `clean --apply` refuses to run until `backup` has captured
 * the rows it is about to delete, and `constrain` refuses to run while orphans remain, because
 * VALIDATE would fail on them.
 *
 * Deleting a CollectionItem also cascades to CollectionItemScore, which the backup does NOT
 * capture and which cannot be reconstructed. Check for scores before cleaning a scored collection.
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

const BACKUP_TABLE = '_orphan_collectionitem_backup';

async function backup() {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${BACKUP_TABLE}" (relation text, row jsonb, "backedUpAt" timestamptz DEFAULT now())`
  );
  for (const { column, table } of relations) {
    await client.query(`DELETE FROM "${BACKUP_TABLE}" WHERE relation = $1`, [column]);
    const { rowCount } = await client.query(
      `INSERT INTO "${BACKUP_TABLE}" (relation, row)
         SELECT $1, to_jsonb(ci) FROM "CollectionItem" ci
          WHERE ci."${column}" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x.id = ci."${column}")`,
      [column]
    );
    console.log(`${column}: backed up ${rowCount} rows to ${BACKUP_TABLE}`);
  }
}

const backedUpCount = async (column) => {
  const { rows } = await client
    .query(`SELECT count(*)::int n FROM "${BACKUP_TABLE}" WHERE relation = $1`, [column])
    .catch(() => ({ rows: [{ n: 0 }] }));
  return rows[0].n;
};

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

    if ((await backedUpCount(column)) < before) {
      console.log(`${column}: run \`backup\` first — ${before} orphans, fewer rows captured`);
      continue;
    }

    // Collected once into a temp table: the anti-join is a full scan, and re-running it per batch
    // would cost minutes each time.
    await client.query(`DROP TABLE IF EXISTS pg_temp.orphan_ids`);
    await client.query(
      `CREATE TEMP TABLE orphan_ids AS
         SELECT ci.id FROM "CollectionItem" ci
          WHERE ci."${column}" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x.id = ci."${column}")`
    );
    await client.query(`CREATE INDEX ON pg_temp.orphan_ids (id)`);

    let deleted = 0;
    for (;;) {
      const { rowCount } = await client.query(
        `DELETE FROM "CollectionItem"
          WHERE id IN (SELECT id FROM pg_temp.orphan_ids ORDER BY id LIMIT ${BATCH_SIZE})`
      );
      // Prune unconditionally and break on an empty queue rather than on a zero-row delete: a
      // batch whose ids were already removed elsewhere would otherwise exit reporting success.
      const { rowCount: pruned } = await client.query(
        `DELETE FROM pg_temp.orphan_ids WHERE id IN (
           SELECT id FROM pg_temp.orphan_ids ORDER BY id LIMIT ${BATCH_SIZE})`
      );
      if (!pruned) break;
      deleted += rowCount ?? 0;
      process.stdout.write(`\r  ${column}: deleted ${deleted}/${before}`);
    }
    await client.query(`DROP TABLE IF EXISTS pg_temp.orphan_ids`);
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

const commands = { count, backup, clean, constrain };
if (!commands[command]) {
  console.error(
    'usage: cleanup-collection-item-orphans.mjs <count|backup|clean|constrain> [--apply] [--only <column>]'
  );
  process.exit(1);
}

await client.connect();
try {
  await commands[command]();
} finally {
  await client.end();
}
