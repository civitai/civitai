/**
 * Copy the Retool-era `UserStrikes` rows out of the moderator database into the main app's
 * `UserStrike`, so there is one strike store.
 *
 *   pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/migrate-legacy-strikes.ts
 *   pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/migrate-legacy-strikes.ts --apply
 *
 * Dry run by default: it reads both databases, resolves everything, and prints exactly what `--apply`
 * would write. Nothing is written without the flag.
 *
 * 🔴 Imported rows are INERT, and that is the whole design. `evaluateStrikeEscalation` sums points over
 *    `status = 'Active' AND "expiresAt" > NOW()` and mutes indefinitely at `INDEFINITE_MUTE_POINTS`.
 *    Importing ~12.9k historical strikes as Active would hand out mutes nobody decided on, off evidence
 *    up to four years old, each with its own notification. So every row lands `Expired`, `points = 0`,
 *    `expiresAt = createdAt`: visible in a strike list, countable by nothing. `verify()` re-reads the
 *    rows and fails the run if that is ever untrue.
 *
 * Idempotent: each imported row carries `retool:UserStrikes:<id>` at the head of `internalNotes`, and a
 * run imports only what is not already marked. Re-running after a partial failure resumes.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
// Type-only, both of them, and that is load-bearing rather than stylistic: tsx does not transpile
// anything under `node_modules`, so a VALUE import of a workspace package (`@civitai/db/kysely`, whose
// export map points at TypeScript source) fails at runtime with "does not provide an export named".
// Erased imports cost nothing at runtime and still give every column name a compile-time check.
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
// A VALUE import, and it resolves because this path is outside `node_modules` — the marker protocol has
// exactly one definition, shared with the reader in `moderation-memory.service.ts`.
import {
  LEGACY_STRIKE_MARKER as MARKER,
  legacyStrikeId,
  legacyStrikeNotes,
} from '../src/lib/legacy-strike-import';

const BATCH = 500;

const apply = process.argv.includes('--apply');

function connect<DB>(name: string): Kysely<DB> {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not configured`);

  // Both hosts present a self-signed cert; encrypted, unverified — the posture `db.ts` and
  // `moderator-db.ts` take at runtime via `sslNoVerify`. It has to be done ON THE URL: node-postgres
  // maps `sslmode=require` to FULL verification (unlike libpq), and a separate `ssl` option is
  // overridden by the URL's sslmode, so passing `rejectUnauthorized: false` alongside it does nothing.
  const url = new URL(raw);
  url.searchParams.set('sslmode', 'no-verify');

  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 4 }),
    }),
  });
}

const main = connect<MainDB>('DATABASE_URL');
const moderator = connect<ModeratorDB>('MODERATOR_DATABASE_URL');

/**
 * `createdBy` holds Retool display names historically and Civitai usernames since the port, so only an
 * exact username match sets `issuedBy`. A fuzzy match would credit the wrong moderator, which is worse
 * than crediting nobody.
 */
async function resolveModerators(names: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return new Map();

  const rows = await main
    .selectFrom('User')
    .select(['id', 'username'])
    .where('username', 'in', unique)
    .execute();

  return new Map(rows.flatMap((r) => (r.username ? [[r.username, r.id] as const] : [])));
}

async function alreadyImported(): Promise<Set<number>> {
  const rows = await main
    .selectFrom('UserStrike')
    .select('internalNotes')
    .where('internalNotes', 'like', `${MARKER}%`)
    .execute();

  return new Set(
    rows.flatMap((r) => {
      const id = legacyStrikeId(r.internalNotes);
      return id === null ? [] : [id];
    })
  );
}

async function migrate() {
  const done = await alreadyImported();
  const total = Number(
    (
      await moderator
        .selectFrom('UserStrikes')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .executeTakeFirst()
    )?.c ?? 0
  );

  console.log(`${total} legacy strikes; ${done.size} already imported.`);

  let cursor = 0;
  let imported = 0;
  let attributed = 0;
  let orphaned = 0;

  for (;;) {
    const batch = await moderator
      .selectFrom('UserStrikes')
      .select(['id', 'userId', 'createdAt', 'createdBy', 'reason'])
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(BATCH)
      .execute();
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;

    const fresh = batch.filter((row) => !done.has(row.id));
    if (!fresh.length) continue;

    // Both resolutions in one round trip per batch rather than one per row.
    const [moderators, accounts] = await Promise.all([
      resolveModerators(fresh.map((r) => r.createdBy)),
      main
        .selectFrom('User')
        .select('id')
        .where(
          'id',
          'in',
          fresh.map((r) => r.userId)
        )
        .execute()
        .then((rows) => new Set(rows.map((r) => r.id))),
    ]);

    // Nothing can display a strike against an account that no longer exists.
    const placeable = fresh.filter((row) => accounts.has(row.userId));
    orphaned += fresh.length - placeable.length;

    const values = placeable.map((row) => {
      const issuedBy = moderators.get(row.createdBy) ?? null;
      if (issuedBy !== null) attributed += 1;
      return {
        userId: row.userId,
        // No typed cause survives: the legacy table had one free-text column and no category.
        reason: 'ManualModAction' as const,
        status: 'Expired' as const,
        points: 0,
        description: (row.reason.trim() || '(no reason recorded)').slice(0, 1000),
        internalNotes: legacyStrikeNotes(row.id, row.createdBy),
        createdAt: row.createdAt,
        expiresAt: row.createdAt,
        issuedBy,
      };
    });

    if (values.length && apply) await main.insertInto('UserStrike').values(values).execute();
    imported += values.length;
    process.stdout.write(`\r  ${imported} prepared…`);
  }

  console.log(
    `\n${apply ? 'Imported' : 'Would import'} ${imported}` +
      ` (${attributed} attributed to a moderator, ${orphaned} skipped — account gone).`
  );
  return imported;
}

/** The gate. Re-reads what landed rather than trusting what was sent. */
async function verify() {
  const countable = await main
    .selectFrom('UserStrike')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('internalNotes', 'like', `${MARKER}%`)
    .where((eb) =>
      eb.or([
        eb('status', '!=', 'Expired'),
        eb('points', '!=', 0),
        eb('expiresAt', '>', new Date()),
      ])
    )
    .executeTakeFirst();

  if (Number(countable?.c ?? 0) > 0)
    throw new Error(
      `FAIL: ${countable?.c} imported strikes are countable and could mute an account.`
    );

  const dupes = await main
    .selectFrom('UserStrike')
    .select('internalNotes')
    .where('internalNotes', 'like', `${MARKER}%`)
    .execute()
    .then((rows) => {
      const seen = new Set<string>();
      const repeated = new Set<string>();
      for (const r of rows) {
        const marker = r.internalNotes?.split(' ')[0] ?? '';
        if (seen.has(marker)) repeated.add(marker);
        seen.add(marker);
      }
      return repeated.size;
    });

  if (dupes > 0) throw new Error(`FAIL: ${dupes} legacy strikes were imported more than once.`);
  console.log('Verified: every imported strike is expired, zero-point, and imported once.');
}

try {
  const imported = await migrate();
  if (apply) await verify();
  else if (imported > 0) console.log('Dry run — nothing written. Re-run with --apply.');
} finally {
  await Promise.all([main.destroy(), moderator.destroy()]);
}
