/**
 * Remove the FIRST legacy-strike import, which `migrate-legacy-strikes.ts` duplicated.
 *
 *   pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/remove-duplicate-legacy-strikes.ts
 *   pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/remove-duplicate-legacy-strikes.ts --apply
 *
 * Dry run by default. Nothing is written without `--apply`.
 *
 * 🔴 The first pass wrote `Active`, `points = 1`, 365-day rows, so its strikes count on the escalation
 *    ladder — deleting one can drop an account below a mute threshold. Not cosmetic.
 *
 * A row is deleted only when a second-pass row carrying the SAME legacy strike id exists, so the
 * account's history survives the delete — with better data than the row being removed (real description
 * text, un-shifted timestamps, resolved moderator attribution). An unpaired first-pass row is reported
 * and kept.
 */
import { Kysely, PostgresDialect, sql, type ExpressionBuilder } from 'kysely';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
// Type-only: tsx does not transpile `node_modules`, so a value import of a workspace package whose
// export map points at TypeScript source fails at runtime. See migrate-legacy-strikes.ts.
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import {
  FIRST_PASS_STRIKE_PREFIX,
  firstPassStrikeId,
  LEGACY_STRIKE_MARKER,
  legacyStrikeId,
} from '../src/lib/legacy-strike-import';

const BATCH = 500;
// Unexported copies of strike.service.ts's ladder — keep in step.
const MUTE_POINTS = 2;
const REVIEW_MUTE_POINTS = 3;
/** Written before the delete, so a failure afterwards cannot lose the only human-actionable output. */
const AFFECTED_USERS_FILE = 'stranded-mute-candidates.json';

const apply = process.argv.includes('--apply');

function connect<DB>(name: string): Kysely<DB> {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not configured`);

  // Self-signed cert, encrypted but unverified — and it has to be set ON THE URL: node-postgres maps
  // `sslmode=require` to full verification and lets the URL override a separate `ssl` option.
  const url = new URL(raw);
  url.searchParams.set('sslmode', 'no-verify');

  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 4 }),
    }),
  });
}

const main = connect<MainDB>('DATABASE_URL');

type Doomed = { id: number; userId: number; points: number; countsNow: boolean };

async function plan() {
  const now = new Date();

  const [firstPass, secondPass] = await Promise.all([
    main
      .selectFrom('UserStrike')
      .select(['id', 'userId', 'points', 'status', 'expiresAt', 'internalNotes'])
      .where('internalNotes', 'like', `${FIRST_PASS_STRIKE_PREFIX}%`)
      .execute(),
    main
      .selectFrom('UserStrike')
      .select(['userId', 'internalNotes'])
      .where('internalNotes', 'like', `${LEGACY_STRIKE_MARKER}%`)
      .execute(),
  ]);

  // Keyed on the ACCOUNT as well as the legacy id. Keyed on the id alone, a first-pass row would be
  // deleted because some second-pass row somewhere carries that id — even one attached to a different
  // account, which loses the strike from this account's history and leaves it only on the other's.
  const preserved = new Set(
    secondPass.flatMap((r) => {
      const id = legacyStrikeId(r.internalNotes);
      return id === null ? [] : [`${r.userId}:${id}`];
    })
  );

  const doomed: Doomed[] = [];
  const unpaired: number[] = [];
  const unparseable: number[] = [];

  for (const row of firstPass) {
    const legacyId = firstPassStrikeId(row.internalNotes);
    if (legacyId === null) {
      unparseable.push(row.id);
      continue;
    }
    if (!preserved.has(`${row.userId}:${legacyId}`)) {
      unpaired.push(row.id);
      continue;
    }
    doomed.push({
      id: row.id,
      userId: row.userId,
      points: row.points,
      countsNow: row.status === 'Active' && row.expiresAt > now,
    });
  }

  const users = new Set(doomed.map((d) => d.userId));
  const counting = doomed.filter((d) => d.countsNow);

  console.log(
    `${firstPass.length} first-pass rows; ${preserved.size} legacy ids preserved by the second pass.`
  );
  console.log(
    `${doomed.length} safe to delete (${counting.length} currently counting for escalation, ` +
      `across ${new Set(counting.map((d) => d.userId)).size} of ${users.size} accounts).`
  );
  if (unpaired.length)
    console.log(`⚠ ${unpaired.length} KEPT — no second-pass row holds their history: ${unpaired}`);
  if (unparseable.length)
    console.log(`⚠ ${unparseable.length} KEPT — marker present but no legacy id: ${unparseable}`);

  return doomed;
}

async function remove(doomed: Doomed[]) {
  const ids = doomed.map((d) => d.id);
  let deleted = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const res = await main.deleteFrom('UserStrike').where('id', 'in', batch).executeTakeFirst();
    deleted += Number(res.numDeletedRows ?? 0);
    process.stdout.write(`\r  ${deleted} deleted…`);
  }
  console.log(`\nDeleted ${deleted}.`);
  return deleted;
}

/**
 * Re-reads what is left rather than trusting what was sent. Batched like the delete: an `IN` list of
 * every id would pass the bind-parameter ceiling on a larger set and throw AFTER the delete committed.
 */
async function verify(doomed: Doomed[], users: number[]) {
  const ids = doomed.map((d) => d.id);
  let survived = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const left = await main
      .selectFrom('UserStrike')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('id', 'in', ids.slice(i, i + BATCH))
      .executeTakeFirst();
    survived += Number(left?.c ?? 0);
  }
  if (survived > 0) throw new Error(`FAIL: ${survived} rows survived the delete.`);

  let withHistory = 0;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const stillHasHistory = await main
      .selectFrom('UserStrike')
      .select((eb) => eb.fn.count<string>('userId').distinct().as('c'))
      .where('userId', 'in', batch)
      .where('internalNotes', 'like', `${LEGACY_STRIKE_MARKER}%`)
      .executeTakeFirst();
    withHistory += Number(stillHasHistory?.c ?? 0);
  }
  if (withHistory !== users.length)
    throw new Error(`FAIL: ${users.length - withHistory} accounts lost their legacy history.`);

  console.log(`Verified: rows gone, all ${users.length} accounts still show their legacy history.`);
}

/**
 * Reported, never written: lifting a mute also means refreshing the user's session, which is the app's
 * job — a raw UPDATE here leaves them muted in their live session. `mutedAt IS NULL` is what separates a
 * mute this system applied from a moderator's decision.
 *
 * TWO tiers, because losing a point can leave an account over-punished without leaving it unpunished:
 * below 2 the mute should be gone entirely, and below 3 an INDEFINITE mute should have been a 3-day one.
 * Reporting only the first tier is how an account stays permanently muted and flagged on 2 points, with
 * the run printing an all-clear — and nothing re-evaluates it, since the strike events that would have
 * are the rows this script just deleted.
 */
async function reportStrandedMutes(users: number[]) {
  const activePoints = (eb: ExpressionBuilder<MainDB & { u: MainDB['User'] }, 'u'>) =>
    eb
      .selectFrom('UserStrike as s')
      .select((e) => e.fn.coalesce(e.fn.sum<number>('s.points'), sql<number>`0`).as('pts'))
      .whereRef('s.userId', '=', 'u.id')
      .where('s.status', '=', 'Active')
      .where('s.expiresAt', '>', new Date());

  const stranded: { id: number; username: string | null; fix: string }[] = [];

  for (let i = 0; i < users.length; i += BATCH) {
    const rows = await main
      .selectFrom('User as u')
      .select([
        'u.id',
        'u.username',
        'u.muteExpiresAt',
        sql<boolean>`coalesce((u."meta"->>'strikeFlaggedForReview')::boolean, false)`.as('flagged'),
        (eb) => activePoints(eb).as('points'),
      ])
      .where('u.id', 'in', users.slice(i, i + BATCH))
      .where('u.muted', '=', true)
      .where('u.mutedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('u.muteExpiresAt', 'is not', null),
          eb(sql<boolean>`(u."meta"->>'strikeFlaggedForReview')::boolean`, '=', true),
        ])
      )
      .where((eb) => eb(activePoints(eb), '<', REVIEW_MUTE_POINTS))
      .execute();

    for (const r of rows) {
      const points = Number(r.points ?? 0);
      const indefinite = r.muteExpiresAt === null || r.flagged;
      if (points < MUTE_POINTS) stranded.push({ ...r, fix: 'unmute — no points left' });
      else if (indefinite)
        stranded.push({ ...r, fix: `downgrade to a timed mute — ${points} points, not 3+` });
    }
  }

  if (!stranded.length) {
    console.log('No account is left over-punished on points this cleanup removed.');
    return;
  }
  console.log(
    `\n⚠ ${stranded.length} account(s) are punished on points that are now gone. Act on them from Mod` +
      ` Studio so the session is refreshed too:`
  );
  for (const u of stranded) console.log(`   ${u.id} ${u.username ?? '(no username)'} — ${u.fix}`);
}

try {
  const doomed = await plan();
  const users = [...new Set(doomed.map((d) => d.userId))];
  if (!doomed.length) console.log('Nothing to do.');
  else if (!apply) console.log('Dry run — nothing written. Re-run with --apply.');
  else {
    // Before the delete: afterwards these accounts are no longer derivable — `plan()` finds nothing on a
    // re-run and prints "Nothing to do.", so a failure between here and the report would lose the one
    // output a human has to act on.
    writeFileSync(AFFECTED_USERS_FILE, JSON.stringify(users));
    await remove(doomed);
    await verify(doomed, users);
    await reportStrandedMutes(users);
  }
} finally {
  await main.destroy();
}
