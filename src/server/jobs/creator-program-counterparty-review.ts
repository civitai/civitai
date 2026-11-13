import { logToAxiom } from '~/server/logging/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  DEFAULT_MAX_INTERMEDIARIES,
  defaultClickhouse,
  findProgramMembers,
} from '~/server/services/creator-program-counterparty-review/detect';
import {
  parseFiledRecord,
  runCounterpartyReview,
  type FiledRecord,
  type IndirectRecord,
} from '~/server/services/creator-program-counterparty-review/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

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

async function getFiled(userId: number) {
  return parseFiledRecord(
    decodeRedisString(await sysRedis.hGet(COUNTERPARTY_REVIEW_WARNINGS, String(userId)))
  );
}

async function setFiled(userId: number, record: FiledRecord) {
  await sysRedis.hSet(COUNTERPARTY_REVIEW_WARNINGS, String(userId), JSON.stringify(record));
}

/**
 * Daily review of Creator Program members who exchange Buzz in both directions with another user,
 * directly or through other users, filed on the moderator app's abuse board for a moderator to
 * decide on. Nothing is sent to the member.
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
      filed: { get: getFiled, set: setFiled },
      indirect: { get: getIndirect, set: setIndirect },
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (name, data) =>
        void logToAxiom({
          type: name.endsWith('-reported') ? 'info' : 'warning',
          name,
          ...data,
        }).catch(() => undefined),
    }),
  { lockExpiration: 10 * 60 }
);
