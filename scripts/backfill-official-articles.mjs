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
 *   node scripts/backfill-official-articles.mjs --user-ids 1,3,43555   # several authors
 *   node scripts/backfill-official-articles.mjs --unmark        # clear instead of set
 *   node scripts/backfill-official-articles.mjs --exclude-ids 6222,6339  # skip these
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
const userIdArg = args.findIndex((a) => a === '--user-id' || a === '--user-ids');
// 12042163 — `constants.system.officialUserId`, the "Public CivitaiOfficial content
// account". Not imported: this is a plain node script and `~/server/common/constants`
// pulls the whole server graph. If that id ever changes, it changes in two places.
//
// Several ids are accepted because the account is not the whole story: Civitai's
// announcements were written from staff accounts for years before that account existed,
// so a backfill keyed on it alone leaves most of the back catalogue unmarked.
const USER_IDS =
  userIdArg === -1
    ? [12042163]
    : String(args[userIdArg + 1] ?? '')
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => id !== 0);

if (!USER_IDS.length || USER_IDS.some((id) => !Number.isInteger(id) || id <= 0)) {
  console.error(`Error: --user-ids takes a comma-separated list of positive integers`);
  process.exit(1);
}

// Reviewed exclusions. An author rule is right for the bulk and wrong for individual
// rows, and the only way to know which is to read the titles — so the exceptions live
// here as ids rather than as a cleverer predicate that would be wrong in a new way later.
const excludeArg = args.indexOf('--exclude-ids');
const EXCLUDE_IDS =
  excludeArg === -1
    ? []
    : String(args[excludeArg + 1] ?? '')
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0);

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
  `select a.id, a.title, a.status, a."publishedAt", u.username
     from "Article" a
     join "User" u on u.id = a."userId"
    where a."userId" = ANY($1) and a."isOfficial" = $2
      and not (a.id = ANY($3))
    order by a."publishedAt" desc nulls last`,
  [USER_IDS, !target, EXCLUDE_IDS]
);

const { rows: alreadyRows } = await client.query(
  `select count(*)::int as n from "Article" where "userId" = ANY($1) and "isOfficial" = $2`,
  [USER_IDS, target]
);
const already = alreadyRows[0].n;

// The count nobody asks for and everybody wants after the fact: articles carrying the
// mark that this rule would NOT have set. A backfill that silently disagrees with the
// moderators who marked things by hand is worth seeing before it runs, not after.
const { rows: outsideRows } = await client.query(
  `select count(*)::int as n from "Article" where NOT ("userId" = ANY($1)) and "isOfficial" = true`,
  [USER_IDS]
);

console.log(
  `Authors ${USER_IDS.join(', ')}: ${pending.length} to ${unmark ? 'unmark' : 'mark'}, ` +
    `${already} already ${unmark ? 'unmarked' : 'marked'}.`
);
console.log(`Marked by someone else (left alone): ${outsideRows[0].n}`);
if (EXCLUDE_IDS.length) console.log(`Excluded by id: ${EXCLUDE_IDS.join(', ')}`);

for (const row of pending.slice(0, 20)) {
  console.log(
    `  ${String(row.id).padStart(6)}  ${String(row.username).padEnd(16)} ${row.status.padEnd(
      9
    )}  ${row.title.slice(0, 60)}`
  );
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
  `update "Article" set "isOfficial" = $2
     where "userId" = ANY($1) and "isOfficial" = $3 and not (id = ANY($4))`,
  [USER_IDS, target, !target, EXCLUDE_IDS]
);

// Read it back rather than trusting rowCount: they should agree, and if they do not, the
// difference is somebody writing the same rows at the same time.
const { rows: afterRows } = await client.query(
  `select count(*)::int as n from "Article" where "userId" = ANY($1) and "isOfficial" = $2`,
  [USER_IDS, target]
);

console.log(`Updated ${rowCount} article(s).`);
console.log(
  `Now ${afterRows[0].n} article(s) by those authors are ${unmark ? 'unmarked' : 'marked'}.`
);
if (afterRows[0].n !== already + rowCount) {
  console.error('⚠ Read-back disagrees with the update count — something else wrote these rows.');
  process.exitCode = 1;
}

await client.end();
