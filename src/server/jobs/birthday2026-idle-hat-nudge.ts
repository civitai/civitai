import { z } from 'zod';
import type { SendSystemNoticesInput, SendSystemNoticesResult } from '@civitai/notifications';
import { dbRead } from '~/server/db/client';
import { birthday2026 } from '~/server/events/birthday2026.event';
import { notifications } from '~/server/notifications/client';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

// The notices route sends a sendId to each user at most once and pins it to this exact message and
// url on its first call, dry runs included: changing either needs a new sendId.
export const IDLE_HAT_NUDGE_SEND_ID = 'birthday2026-idle-hat-nudge';
export const IDLE_HAT_NUDGE_MESSAGE =
  "Your birthday hat isn't on anything yet. Put it on an image, model or article to score for Team {team}.";
export const IDLE_HAT_NUDGE_URL = `/events/${BIRTHDAY_2026_EVENT}`;

export type IdleHatOwner = { userId: number; teams: string[] };

/**
 * One recipient per idle owner. An owner whose hats name exactly one team is told that team; one
 * whose hats name none or several is told the team the event assigns them.
 */
export async function toIdleHatRecipients(
  owners: IdleHatOwner[],
  getUserTeam: (userId: number) => Promise<string>
) {
  let resolvedByEvent = 0;
  const recipients: { userId: number; params: { team: string } }[] = [];
  for (const { userId, teams } of owners) {
    let team = teams.length === 1 ? teams[0] : undefined;
    if (!team) {
      team = await getUserTeam(userId);
      resolvedByEvent++;
    }
    recipients.push({ userId, params: { team } });
  }
  return { recipients, resolvedByEvent };
}

export async function getIdleHatOwners(): Promise<IdleHatOwner[]> {
  return dbRead.$queryRaw<IdleHatOwner[]>`
    SELECT uc."userId",
      array_remove(array_agg(DISTINCT c.data->>'team'), NULL) AS teams
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    WHERE c.type = 'ContentDecoration' AND c.data->>'event' = ${BIRTHDAY_2026_EVENT}
    GROUP BY uc."userId"
    HAVING bool_and(uc."equippedToId" IS NULL)
  `;
}

const querySchema = z.object({ mode: z.enum(['dry-run', 'send']).default('dry-run') });

type Deps = {
  getOwners: () => Promise<IdleHatOwner[]>;
  getUserTeam: (userId: number) => Promise<string>;
  sendSystemNotices: (input: SendSystemNoticesInput) => Promise<SendSystemNoticesResult>;
  now: () => Date;
};

export async function runIdleHatNudge(
  query: unknown,
  {
    getOwners = getIdleHatOwners,
    getUserTeam = (userId) => birthday2026.getUserTeam(userId),
    sendSystemNotices = notifications.sendSystemNotices,
    now = () => new Date(),
  }: Partial<Deps> = {}
) {
  const { mode } = querySchema.parse(query ?? {});
  const at = now();
  if (mode === 'send' && (at < BIRTHDAY_2026_STARTS_AT || at >= BIRTHDAY_2026_ENDS_AT))
    throw new Error(`${BIRTHDAY_2026_EVENT} is not running; refusing to send`);

  const owners = await getOwners();
  if (!owners.length) return { mode, idleOwners: 0 };
  const { recipients, resolvedByEvent } = await toIdleHatRecipients(owners, getUserTeam);
  const result = await sendSystemNotices({
    sendId: IDLE_HAT_NUDGE_SEND_ID,
    mode,
    type: 'system-announcement',
    message: IDLE_HAT_NUDGE_MESSAGE,
    url: IDLE_HAT_NUDGE_URL,
    recipients,
    sentBy: `run-jobs:${IDLE_HAT_NUDGE_SEND_ID}`,
    reason: 'Birthday 2026: remind hat owners whose hats are not on anything',
  });

  // Counts and copy only: the operator reading this response does not need user ids.
  return {
    mode,
    idleOwners: owners.length,
    resolvedByEvent,
    counts: result.counts,
    samples: result.samples.map((s) => s.message),
  };
}

export const birthday2026IdleHatNudge = createJob(
  IDLE_HAT_NUDGE_SEND_ID,
  UNRUNNABLE_JOB_CRON,
  (ctx) => runIdleHatNudge(ctx.req?.query)
);
