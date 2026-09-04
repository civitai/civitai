#!/usr/bin/env node
/**
 * Backfill `Article."isOfficial"` for articles published by the Civitai account.
 *
 * `isOfficial` (civitai#4624) starts false for every existing article, so the badge is
 * invisible until something marks the back catalogue. The rule this script applies is the
 * one the codebase already uses to mean "ours":
 * `constants.system.officialUserId` — the same id `resource-select.service.ts` uses to
 * define its "official" tab.
 *
 * 🔴 DRY RUN BY DEFAULT. It prints what it would change and writes nothing until you pass
 * `--apply`. That is deliberate: the column is a public provenance claim, and a backfill
 * that marks the wrong author is a false claim on somebody else's writing.
 *
 * Usage:
 *   node scripts/backfill-official-articles.mjs                 # dry run against DATABASE_URL
 *   node scripts/backfill-official-articles.mjs --apply
 *   node scripts/backfill-official-articles.mjs --user-id 123   # a different author
 *   node scripts/backfill-official-articles.mjs --unmark        # clear instead of set
 *
 * The connection comes from DATABASE_URL, so it follows whatever `.env` the tree points
 * at. Check the host it prints before passing --apply.
 */

import { config } from 'dotenv';
import pg from 'pg';

config();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const unmark = args.includes('--unmark');
const userIdArg = args.indexOf('--user-id');
// 12042163 — `constants.system.officialUserId`, the "Public CivitaiOfficial content
// account". Not imported: this is a plain node script and `~/server/common/constants`
// pulls the whole server graph. If that id ever changes, it changes in two places.
const OFFICIAL_USER_ID = userIdArg === -1 ? 12042163 : Number(args[userIdArg + 1]);

if (!Number.isInteger(OFFICIAL_USER_ID) || OFFICIAL_USER_ID <= 0) {
  console.error(`Error: --user-id must be a positive integer, got ${args[userIdArg + 1]}`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Error: DATABASE_URL is not set');
  process.exit(1);
}

const target = !unmark;
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

// Say which database, every run. A backfill pointed at the wrong one is the failure this
// line exists to prevent, and `.env` here has been swapped between dev and prod before.
const [{ host, db }] = (
  await client.query(`select inet_server_addr()::text as host, current_database() as db`)
).rows;
console.log(`Database: ${db} @ ${host ?? 'local'}  (from DATABASE_URL)`);

const { rows: pending } = await client.query(
  `select a.id, a.title, a.status, a."publishedAt"
     from "Article" a
    where a."userId" = $1 and a."isOfficial" = $2
    order by a."publishedAt" desc nulls last`,
  [OFFICIAL_USER_ID, !target]
);

const { rows: alreadyRows } = await client.query(
  `select count(*)::int as n from "Article" where "userId" = $1 and "isOfficial" = $2`,
  [OFFICIAL_USER_ID, target]
);
const already = alreadyRows[0].n;

// The count nobody asks for and everybody wants after the fact: articles carrying the
// mark that this rule would NOT have set. A backfill that silently disagrees with the
// moderators who marked things by hand is worth seeing before it runs, not after.
const { rows: outsideRows } = await client.query(
  `select count(*)::int as n from "Article" where "userId" <> $1 and "isOfficial" = true`,
  [OFFICIAL_USER_ID]
);

console.log(
  `Author ${OFFICIAL_USER_ID}: ${pending.length} to ${unmark ? 'unmark' : 'mark'}, ` +
    `${already} already ${unmark ? 'unmarked' : 'marked'}.`
);
console.log(`Marked by someone else (left alone): ${outsideRows[0].n}`);

for (const row of pending.slice(0, 20)) {
  console.log(`  ${row.id}  ${row.status.padEnd(9)}  ${row.title.slice(0, 70)}`);
}
if (pending.length > 20) console.log(`  … and ${pending.length - 20} more`);

if (!pending.length) {
  console.log('Nothing to do.');
  await client.end();
  process.exit(0);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to make these changes.');
  await client.end();
  process.exit(0);
}

const { rowCount } = await client.query(
  `update "Article" set "isOfficial" = $2 where "userId" = $1 and "isOfficial" = $3`,
  [OFFICIAL_USER_ID, target, !target]
);

// Read it back rather than trusting rowCount: they should agree, and if they do not, the
// difference is somebody writing the same rows at the same time.
const { rows: afterRows } = await client.query(
  `select count(*)::int as n from "Article" where "userId" = $1 and "isOfficial" = $2`,
  [OFFICIAL_USER_ID, target]
);

console.log(`Updated ${rowCount} article(s).`);
console.log(
  `Now ${afterRows[0].n} article(s) by ${OFFICIAL_USER_ID} are ${unmark ? 'unmarked' : 'marked'}.`
);
if (afterRows[0].n !== already + rowCount) {
  console.error('⚠ Read-back disagrees with the update count — something else wrote these rows.');
  process.exitCode = 1;
}

await client.end();
