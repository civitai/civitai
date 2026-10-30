import { constants } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createMessage, upsertChat } from '~/server/services/chat.service';
import {
  DEFAULT_MAX_INTERMEDIARIES,
  defaultClickhouse,
  findProgramMembers,
} from '~/server/services/creator-program-counterparty-review/detect';
import { renderWarningMessage } from '~/server/services/creator-program-counterparty-review/report';
import {
  runCounterpartyReview,
  type IndirectRecord,
  type WarningRecord,
} from '~/server/services/creator-program-counterparty-review/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { ChatMessageType } from '~/shared/utils/prisma/enums';
import { createJob } from './job';

const SYSTEM_USER_ID = constants.system.user.id;
const {
  COUNTERPARTY_REVIEW_MIN,
  COUNTERPARTY_REVIEW_WARNINGS,
  COUNTERPARTY_REVIEW_MAX_HOPS,
  COUNTERPARTY_REVIEW_INDIRECT,
} = REDIS_SYS_KEYS.CREATOR_PROGRAM;

/** Buzz each way with one counterparty; a positive stored value overrides it. */
export const DEFAULT_COUNTERPARTY_REVIEW_MIN = 25_000;

export async function readMinimum() {
  const value = Number(decodeRedisString(await sysRedis.get(COUNTERPARTY_REVIEW_MIN)));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COUNTERPARTY_REVIEW_MIN;
}

export async function readMaxIntermediaries() {
  const value = Number(decodeRedisString(await sysRedis.get(COUNTERPARTY_REVIEW_MAX_HOPS)));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_INTERMEDIARIES;
}

async function getIndirect(userId: number): Promise<IndirectRecord | null> {
  const raw = decodeRedisString(await sysRedis.hGet(COUNTERPARTY_REVIEW_INDIRECT, String(userId)));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IndirectRecord;
  } catch {
    return null;
  }
}

async function setIndirect(userId: number, record: IndirectRecord) {
  await sysRedis.hSet(COUNTERPARTY_REVIEW_INDIRECT, String(userId), JSON.stringify(record));
}

async function getWarning(userId: number): Promise<WarningRecord | null> {
  const raw = decodeRedisString(await sysRedis.hGet(COUNTERPARTY_REVIEW_WARNINGS, String(userId)));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WarningRecord;
  } catch {
    return null;
  }
}

async function setWarning(userId: number, record: WarningRecord) {
  await sysRedis.hSet(COUNTERPARTY_REVIEW_WARNINGS, String(userId), JSON.stringify(record));
}

/** The same 1:1 chat from the Civitai account that staff outreach uses. */
export async function sendWarning(member: { id: number; username: string | null }) {
  const chat = await upsertChat({
    userIds: [SYSTEM_USER_ID, member.id],
    userId: SYSTEM_USER_ID,
    isModerator: true,
  });
  await createMessage({
    chatId: chat.id,
    userId: SYSTEM_USER_ID,
    isModerator: true,
    contentType: ChatMessageType.Markdown,
    content: renderWarningMessage(member.username),
  });
  return { chatId: chat.id };
}

/**
 * Daily review of Creator Program members who exchange Buzz in both directions with another user,
 * directly or through other users, filed on the moderator app's abuse board. A member filed for a
 * direct exchange the first time gets a one-time warning message; one filed again after that, or
 * for an indirect one, is left for a moderator to decide on.
 */
export const creatorProgramCounterpartyReview = createJob(
  'creator-program-counterparty-review',
  '0 10 * * *',
  async () =>
    runCounterpartyReview({
      ch: defaultClickhouse(),
      readMinimum,
      readMaxIntermediaries,
      findMembers: findProgramMembers,
      warnings: { get: getWarning, set: setWarning },
      indirect: { get: getIndirect, set: setIndirect },
      sendWarning,
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (name, data) =>
        void logToAxiom(
          { type: name.endsWith('-reported') ? 'info' : 'warning', name, ...data },
          'moderation'
        ).catch(() => undefined),
    }),
  { lockExpiration: 10 * 60 }
);
