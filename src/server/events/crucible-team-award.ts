import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { loadEvents } from '~/server/events/load-events';
import { eventPlayerEligibleSql } from '~/server/events/player-eligibility';
import { EVENT_POINTS_LEDGER_TABLE } from '~/server/events/points/award';
import { eventSeasonKeys, liveBucket, LIVE_BUCKET_TTL_S } from '~/server/events/points/keys';
import { markEventTeamsDirty } from '~/server/events/points/push';
import {
  CRUCIBLE_TEAM_AWARDS,
  crucibleTeamAwardLedgerRow,
} from '~/server/events/scoring/crucible-team-awards';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
import type {
  CrucibleEntryRef,
  CrucibleEntrySubscriber,
} from '~/server/services/crucible-entry-accepted';

const AWARDED_TTL_PAST_END_MS = 7 * 24 * 60 * 60 * 1000;

type LedgerRow = ReturnType<typeof crucibleTeamAwardLedgerRow>;

async function insertLedger(rows: LedgerRow[]) {
  if (!clickhouse || !rows.length) return;
  await clickhouse.insert({
    table: EVENT_POINTS_LEDGER_TABLE,
    values: rows,
    format: 'JSONEachRow',
  });
}

async function eventByName(name: string) {
  const events = await loadEvents();
  return events.find((e) => e.name === name);
}

/** The crucible's tags and the entrant's joined team, read from the database, never the caller. */
async function awardsFor(entry: CrucibleEntryRef) {
  const crucible = await dbWrite.crucible.findUnique({
    where: { id: entry.crucibleId },
    select: { eventTags: true },
  });
  return CRUCIBLE_TEAM_AWARDS.filter((a) => crucible?.eventTags.includes(a.eventTag));
}

async function grant(entry: CrucibleEntryRef & { acceptedAt: Date }) {
  for (const award of await awardsFor(entry)) {
    const event = await eventByName(award.event);
    const join = event?.join;
    if (!event || !join) continue;
    const at = entry.acceptedAt;
    if (at < event.startDate || at >= event.endDate) continue;

    const [player] = await dbWrite.$queryRaw<{ team: string; eligible: boolean }[]>`
      SELECT c.data->>'team' AS team, ${eventPlayerEligibleSql(event.startDate)} AS eligible
      FROM "User" u
      JOIN "UserCosmetic" uc ON uc."userId" = u.id
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE u.id = ${entry.userId}
        AND c.type = 'ContentDecoration'
        AND uc."claimKey" = ${join.claimKey}
        AND c.data->>'event' = ${event.name}
        AND c.data->>'design' = ${join.design}
        AND c.data->>'team' IS NOT NULL
      ORDER BY uc."obtainedAt", c.id
      LIMIT 1
    `;
    if (!player?.eligible || !event.teams.includes(player.team)) continue;

    // The ledger row is the record; a repeated accept writes a second add, which the settle counts
    // once. The accepted hash keeps that rare.
    await insertLedger([crucibleTeamAwardLedgerRow(event.name, 'add', entry, at, player.team)]);

    try {
      // Live counts each entrant once per crucible, as the settle does, so a second entry doesn't
      // lift the team until the settle takes it back.
      const keys = eventSeasonKeys(event.name, 'live');
      const awarded = keys.crucibleAwarded(entry.crucibleId);
      const first = await sysRedis.sAdd(awarded, String(entry.userId));
      await sysRedis.expireAt(awarded, new Date(event.endDate.getTime() + AWARDED_TTL_PAST_END_MS));
      if (!first) continue;
      const key = keys.live(liveBucket(at), 'team');
      await sysRedis.hIncrBy(key, player.team, award.points);
      await sysRedis.expire(key, LIVE_BUCKET_TTL_S);
      markEventTeamsDirty(event, at);
    } catch (error) {
      // The row is the record; the live total catches up at the next settle.
      logToAxiom({
        type: 'error',
        name: 'crucible-team-award-live-failed',
        ...entry,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Writes a remove for each award event under way, whether or not this entry was granted: a remove
 * with no add counts for nothing. The live total is not taken down: the next settle recounts.
 */
async function revoke(entry: CrucibleEntryRef) {
  const now = new Date();
  const rows: LedgerRow[] = [];
  for (const award of CRUCIBLE_TEAM_AWARDS) {
    const event = await eventByName(award.event);
    if (event && now >= event.startDate)
      rows.push(crucibleTeamAwardLedgerRow(event.name, 'remove', entry, now));
  }
  await insertLedger(rows);
}

export const crucibleTeamAwardSubscriber: CrucibleEntrySubscriber = {
  name: 'crucible-team-award',
  eventTags: CRUCIBLE_TEAM_AWARDS.map((a) => a.eventTag),
  accept: grant,
  revoke,
};
