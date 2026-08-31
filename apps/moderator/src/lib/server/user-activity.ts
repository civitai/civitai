import { getClickhouse } from './clickhouse';

// The main app writes a `userActivities` row on mute/unmute (`track.userActivity`). The spoke owning
// those mutations meant it wrote none — so mod-initiated mutes vanished from the very table this page's
// own Security signals panel reads.
//
// `userId` is the ACTOR and `targetUserId` the subject, matching how the table is read everywhere else.
// `landingPage` is the one column with no default, so it must be sent. Ban/unban are not written here:
// that path delegates to the main app, which records its own row.
//
// Best-effort — analytics must never fail an enforcement action that has already landed in Postgres.
export async function recordUserActivity(
  type: 'Muted' | 'Unmuted',
  targetUserId: number,
  moderatorId: number
): Promise<void> {
  try {
    await getClickhouse().insert({
      table: 'userActivities',
      values: [{ type, userId: moderatorId, targetUserId, landingPage: '' }],
      format: 'JSONEachRow',
    });
  } catch (e) {
    console.error('[user-activity] failed to record', type, e);
  }
}
