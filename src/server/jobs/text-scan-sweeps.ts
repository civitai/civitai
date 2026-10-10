import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { isTextScanEnabled } from '~/server/services/text-scan/mode';
import { scamEligibleAuthors } from '~/server/services/text-scan/profiles/scam-text';
import { scanEntity } from '~/server/services/text-scan/submit';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { ChatMessageType } from '~/shared/utils/prisma/enums';

export const TEXT_SCAN_CHAT_CURSOR_KEY = 'text-scan-chat-cursor';
export const TEXT_SCAN_USER_CURSOR_KEY = 'text-scan-new-user-cursor';
const BATCH_SIZE = 2000;
const MAX_SCANS_PER_BATCH = 200;
const SETTLE_MS = 2 * 60 * 1000;
const TIME_BUDGET_MS = 3 * 60 * 1000;
const SCAN_CONCURRENCY = 10;

export type SweepOptions = {
  batchSize?: number;
  maxScansPerBatch?: number;
  budgetMs?: number;
  clock?: () => number;
};
export type SweepResult = {
  initialised?: true;
  disabled?: true;
  rows: number;
  scanned: number;
  submitted: number;
  caughtUp: boolean;
  lagMs: number;
};

async function readCursor(key: string) {
  const row = await dbWrite.keyValue.findUnique({ where: { key } });
  return typeof row?.value === 'number' ? row.value : null;
}

async function writeCursor(key: string, value: number) {
  await dbWrite.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function scanAll(entityType: TextScanEntityType, entityIds: number[]) {
  let submitted = 0;
  await limitConcurrency(
    entityIds.map((entityId) => async () => {
      try {
        const result = await scanEntity({ entityType, entityId });
        if (result.status === 'submitted') submitted++;
      } catch (error) {
        await logToAxiom({
          name: 'text-scan',
          type: 'error',
          message: 'sweep scan threw',
          entityType,
          entityId,
          error: (error as Error).message,
        }).catch(() => undefined);
      }
    }),
    SCAN_CONCURRENCY
  );
  return submitted;
}

/** How many leading rows fit before a new scan key would exceed the cap. */
function cappedPrefixLength<T>(rows: T[], scanKey: (row: T) => string | null, cap: number) {
  const keys = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const key = scanKey(rows[i]);
    if (key === null || keys.has(key)) continue;
    if (keys.size >= cap) return i;
    keys.add(key);
  }
  return rows.length;
}

async function sweep<T extends { id: number; createdAt: Date }>({
  job,
  cursorKey,
  now,
  options,
  latestId,
  readBatch,
  scanKey,
  scanRows,
}: {
  job: string;
  cursorKey: string;
  now: Date;
  options: SweepOptions;
  latestId: () => Promise<number | undefined>;
  readBatch: (cursor: number, take: number) => Promise<T[]>;
  /** Rows sharing a key are one scan; `null` rows are passed over but still move the cursor. */
  scanKey: (row: T) => string | null;
  scanRows: (rows: T[]) => Promise<{ scanned: number; submitted: number }>;
}): Promise<SweepResult> {
  const {
    batchSize = BATCH_SIZE,
    maxScansPerBatch = MAX_SCANS_PER_BATCH,
    budgetMs = TIME_BUDGET_MS,
    clock = Date.now,
  } = options;
  if (!(await isTextScanEnabled())) {
    // Keep pace without reading rows: switched back on, the sweep resumes at most one run behind,
    // instead of skipping to whatever is newest then.
    await writeCursor(cursorKey, (await latestId()) ?? 0);
    return { disabled: true, rows: 0, scanned: 0, submitted: 0, caughtUp: true, lagMs: 0 };
  }
  let cursor = await readCursor(cursorKey);
  if (cursor === null) {
    await writeCursor(cursorKey, (await latestId()) ?? 0);
    return { initialised: true, rows: 0, scanned: 0, submitted: 0, caughtUp: true, lagMs: 0 };
  }

  const settledBefore = new Date(now.getTime() - SETTLE_MS);
  const deadline = clock() + budgetMs;
  const result: SweepResult = { rows: 0, scanned: 0, submitted: 0, caughtUp: false, lagMs: 0 };
  let lastCreatedAt: Date | null = null;

  do {
    const batch = await readBatch(cursor, batchSize);
    // Stop at the first unsettled row, not merely skip it: a later, settled row would carry the
    // cursor past it and it would never be read.
    const firstUnsettled = batch.findIndex((row) => row.createdAt > settledBefore);
    const settled = firstUnsettled === -1 ? batch : batch.slice(0, firstUnsettled);
    const processed = settled.slice(0, cappedPrefixLength(settled, scanKey, maxScansPerBatch));
    if (processed.length) {
      const { scanned, submitted } = await scanRows(processed);
      cursor = processed[processed.length - 1].id;
      await writeCursor(cursorKey, cursor);
      lastCreatedAt = processed[processed.length - 1].createdAt;
      result.rows += processed.length;
      result.scanned += scanned;
      result.submitted += submitted;
    }
    const cappedEarly = processed.length < settled.length;
    if (!cappedEarly && (settled.length < batch.length || batch.length < batchSize)) {
      result.caughtUp = true;
      break;
    }
  } while (clock() < deadline);

  if (!result.caughtUp) {
    result.lagMs = lastCreatedAt ? now.getTime() - lastCreatedAt.getTime() : 0;
    await logToAxiom({
      name: 'text-scan',
      type: 'warning',
      message: 'sweep behind',
      job,
      lagMs: result.lagMs,
      rows: result.rows,
    }).catch(() => undefined);
  }
  return result;
}

type ChatRow = {
  id: number;
  chatId: number;
  userId: number;
  createdAt: Date;
  contentType: ChatMessageType;
  deletedAt: Date | null;
};

const chatWindowKey = (message: ChatRow) =>
  message.userId > 0 && message.contentType === ChatMessageType.Markdown && !message.deletedAt
    ? `${message.chatId}:${message.userId}`
    : null;

export function sweepChatWindows(now = new Date(), options: SweepOptions = {}) {
  return sweep<ChatRow>({
    job: 'text-scan-chat-windows',
    cursorKey: TEXT_SCAN_CHAT_CURSOR_KEY,
    now,
    options,
    latestId: async () =>
      (await dbWrite.chatMessage.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id,
    // Primary: a lagging replica would let the cursor pass rows it never returned.
    readBatch: (cursor, take) =>
      dbWrite.chatMessage.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          chatId: true,
          userId: true,
          createdAt: true,
          contentType: true,
          deletedAt: true,
        },
      }),
    scanKey: chatWindowKey,
    scanRows: async (messages) => {
      const windows = new Map<string, { senderId: number; newestId: number }>();
      for (const message of messages) {
        const key = chatWindowKey(message);
        if (!key) continue;
        const newestId = Math.max(windows.get(key)?.newestId ?? 0, message.id);
        windows.set(key, { senderId: message.userId, newestId });
      }
      const eligible = await scamEligibleAuthors([...windows.values()].map((w) => w.senderId));
      const ids = [...windows.values()]
        .filter((w) => eligible.has(w.senderId))
        .map((w) => w.newestId);
      return { scanned: ids.length, submitted: await scanAll('ChatMessage', ids) };
    },
  });
}

type UserRow = { id: number; username: string | null; deletedAt: Date | null; createdAt: Date };

const newUserKey = (user: UserRow) => (user.username && !user.deletedAt ? String(user.id) : null);

export function sweepNewUsers(now = new Date(), options: SweepOptions = {}) {
  return sweep<UserRow>({
    job: 'text-scan-new-users',
    cursorKey: TEXT_SCAN_USER_CURSOR_KEY,
    now,
    options,
    latestId: async () =>
      (await dbWrite.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id,
    readBatch: (cursor, take) =>
      dbWrite.user.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, username: true, deletedAt: true, createdAt: true },
      }),
    scanKey: newUserKey,
    scanRows: async (users) => {
      const ids = users.filter((u) => newUserKey(u) !== null).map((u) => u.id);
      return { scanned: ids.length, submitted: await scanAll('User', ids) };
    },
  });
}

export const textScanChatWindowsJob = createJob('text-scan-chat-windows', '*/5 * * * *', () =>
  sweepChatWindows()
);
export const textScanNewUsersJob = createJob('text-scan-new-users', '*/5 * * * *', () =>
  sweepNewUsers()
);
