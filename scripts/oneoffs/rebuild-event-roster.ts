/**
 * Rebuilds an event's team rosters in sysRedis from User.settings, for when Redis lost them.
 *
 * The roster sets (src/server/events/points/roster.ts) are the operating store and the opt-in in
 * User.settings is the durable record. The hourly reconcile only revisits members Redis still lists,
 * so after a loss this is what brings everyone back. It scans User, so run it by hand, never on a
 * schedule.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/rebuild-event-roster.ts birthday2026            # dry run
 *   npm run tsscript scripts/oneoffs/rebuild-event-roster.ts birthday2026 --execute  # write
 */
import { dbWrite } from '~/server/db/client';
import {
  rebuildEventRoster,
  ROSTER_SETTING,
  rosterEvents,
} from '~/server/events/points/roster-sync';

async function main() {
  const [name, flag] = process.argv.slice(2);
  if (!name) throw new Error('Pass the event name, e.g. birthday2026');
  const event = (await rosterEvents()).find((e) => e.name === name);
  if (!event) throw new Error(`${name} has no roster (no join, or its preview has not started)`);

  if (flag !== '--execute') {
    const [{ count }] = await dbWrite.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "User"
      WHERE (settings -> ${ROSTER_SETTING} ->> ${name}) = 'true'
    `;
    console.log(`dry run: ${count} users opted in to ${name}; pass --execute to rebuild`);
    return;
  }
  const result = await rebuildEventRoster(event);
  console.log(`rebuilt ${name}: ${result.optedIn} opted in, ${result.listed} listed`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
