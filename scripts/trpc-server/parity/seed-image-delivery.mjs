#!/usr/bin/env node
/**
 * Writes the rows the image-delivery parity cases read (`IMAGE_DELIVERY_ROWS` in `cases.mjs`) to
 * the parity job's throwaway, otherwise EMPTY database: only the columns and enum types the
 * endpoint's query touches, not the app schema. Re-runnable: it drops and recreates what it made.
 *
 * It then reads the rows back and fails unless every one is there, so a seed that wrote nothing
 * cannot pass as one that did.
 *
 * Usage: node seed-image-delivery.mjs --database-url postgresql://…
 */

import { parseArgs } from 'node:util';
import pg from 'pg';
import { IMAGE_DELIVERY_ROWS } from './cases.mjs';

const { values: args } = parseArgs({ options: { 'database-url': { type: 'string' } } });
if (!args['database-url']) {
  console.error('--database-url is required');
  process.exit(2);
}

const client = new pg.Client({ connectionString: args['database-url'] });
await client.connect();
try {
  await client.query(`
    DROP TABLE IF EXISTS "Image";
    DROP TYPE IF EXISTS "MediaType";
    DROP TYPE IF EXISTS "ImageIngestionStatus";
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id integer PRIMARY KEY,
      url text NOT NULL,
      "hideMeta" boolean NOT NULL DEFAULT false,
      type "MediaType" NOT NULL DEFAULT 'image',
      "mimeType" text,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending'
    );
  `);
  for (const row of IMAGE_DELIVERY_ROWS) {
    await client.query(
      `INSERT INTO "Image" (id, url, "hideMeta", type, "mimeType", ingestion)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      row
    );
  }
  const { rows } = await client.query('SELECT count(*)::int AS n FROM "Image"');
  if (rows[0].n !== IMAGE_DELIVERY_ROWS.length) {
    console.error(`FAIL: wrote ${IMAGE_DELIVERY_ROWS.length} rows, read back ${rows[0].n}`);
    process.exit(1);
  }
  console.log(`seeded ${rows[0].n} "Image" rows`);
} finally {
  await client.end();
}
