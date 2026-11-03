import { createHash } from 'node:crypto';
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

export const IDLE_HAT_NUDGE_JOB = 'birthday2026-idle-hat-nudge';

// The notices route sends a sendId to each user at most once and pins it to this exact type, message
// and url on its first call, dry runs included: changing any of them needs a new sendId.
// First wave (a system-announcement, so never pushed); kept so later sends exclude its recipients.
export const IDLE_HAT_NUDGE_LEGACY_SEND_ID = IDLE_HAT_NUDGE_JOB;
export const IDLE_HAT_REMINDER_SEND_ID = 'birthday2026-idle-hat-reminder';
export const IDLE_HAT_HOLDOUT_SEND_ID = 'birthday2026-idle-hat-reminder-holdout';
export const IDLE_HAT_NUDGE_MESSAGE =
  "Your birthday hat isn't on anything yet. Put it on an image, model or article to score for Team {team}.";
export const IDLE_HAT_NUDGE_URL = `/events/${BIRTHDAY_2026_EVENT}`;
export const IDLE_HAT_PUSH_TITLE = 'Birthday hats';
const HOLDOUT_PERCENT = 10;

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

/** Of these users, those an event-reminder would actually push to: a subscription plus the type on. */
export async function getPushableUserIds(userIds: number[]): Promise<number[]> {
  if (!userIds.length) return [];
  const rows = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT DISTINCT ps."userId"
    FROM "PushSubscription" ps
    JOIN "UserPushSetting" ups ON ups."userId" = ps."userId" AND ups.type = 'event-reminder'
    WHERE ps."userId" = ANY(${userIds}::int[])
  `;
  return rows.map((r) => r.userId);
}

/** Deterministic per user, so a re-run hashes everyone the same way. */
export function isInHoldout(userId: number) {
  const digest = createHash('sha256').update(`${IDLE_HAT_HOLDOUT_SEND_ID}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100 < HOLDOUT_PERCENT;
}

const querySchema = z.object({ mode: z.enum(['dry-run', 'send']).default('dry-run') });

type Deps = {
  getOwners: () => Promise<IdleHatOwner[]>;
  getPushable: (userIds: number[]) => Promise<number[]>;
  getUserTeam: (userId: number) => Promise<string>;
  sendSystemNotices: (input: SendSystemNoticesInput) => Promise<SendSystemNoticesResult>;
  now: () => Date;
};

/**
 * Holdout (10% of push-reachable owners) gets the same text as a system-announcement, which is never
 * pushed, so the arms differ by the push alone. Each arm excludes the other and the first wave so
 * nobody is nudged twice.
 */
export async function runIdleHatNudge(
  query: unknown,
  {
    getOwners = getIdleHatOwners,
    getPushable = getPushableUserIds,
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
  const pushable = new Set(await getPushable(recipients.map((r) => r.userId)));
  const holdout = recipients.filter((r) => pushable.has(r.userId) && isInHoldout(r.userId));
  const reminder = recipients.filter((r) => !holdout.includes(r));

  const common = {
    mode,
    message: IDLE_HAT_NUDGE_MESSAGE,
    url: IDLE_HAT_NUDGE_URL,
    sentBy: `run-jobs:${IDLE_HAT_NUDGE_JOB}`,
    reason: 'Birthday 2026: remind hat owners whose hats are not on anything',
  };
  const send = async (
    arm: typeof recipients,
    input: Omit<SendSystemNoticesInput, keyof typeof common | 'recipients'>
  ) => (arm.length ? sendSystemNotices({ ...common, ...input, recipients: arm }) : undefined);

  const reminderResult = await send(reminder, {
    sendId: IDLE_HAT_REMINDER_SEND_ID,
    type: 'event-reminder',
    title: IDLE_HAT_PUSH_TITLE,
    excludeSendIds: [IDLE_HAT_NUDGE_LEGACY_SEND_ID, IDLE_HAT_HOLDOUT_SEND_ID],
  });
  const holdoutResult = await send(holdout, {
    sendId: IDLE_HAT_HOLDOUT_SEND_ID,
    type: 'system-announcement',
    excludeSendIds: [IDLE_HAT_NUDGE_LEGACY_SEND_ID, IDLE_HAT_REMINDER_SEND_ID],
  });

  // Counts and copy only: the operator reading this response does not need user ids.
  return {
    mode,
    idleOwners: owners.length,
    resolvedByEvent,
    pushable: pushable.size,
    reminder: reminderResult && { counts: reminderResult.counts },
    holdout: holdoutResult && { counts: holdoutResult.counts },
    samples: (reminderResult ?? holdoutResult)?.samples.map((s) => s.message) ?? [],
  };
}

export const birthday2026IdleHatNudge = createJob(IDLE_HAT_NUDGE_JOB, UNRUNNABLE_JOB_CRON, (ctx) =>
  runIdleHatNudge(ctx.req?.query)
);
