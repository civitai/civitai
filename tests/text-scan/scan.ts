import { one, utcParam } from './db';
import { classifyScanRow } from './logic';
import { waitFor } from './wait';

export const SCAN_TIMEOUT_MS = 300_000;

export type EmRow = {
  entityType: string;
  entityId: number;
  status: 'Pending' | 'Succeeded' | 'Failed' | 'Expired' | 'Canceled';
  workflowId: string | null;
  triggeredLabels: string[];
  nsfwLevel: number | null;
  result: {
    version?: number;
    labels?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    textHash?: string;
  } | null;
  updatedAt: Date;
};

export type EmRowKind = 'live' | 'shadow';
export const emEntityType = (entityType: string, kind: EmRowKind) =>
  kind === 'shadow' ? `${entityType}:shadow` : entityType;

const EM_COLUMNS = `"entityType", "entityId", status, "workflowId", "triggeredLabels", "nsfwLevel", result, "updatedAt"`;

export function getEm(entityType: string, entityId: number, kind: EmRowKind) {
  return one<EmRow>(
    `SELECT ${EM_COLUMNS} FROM "EntityModeration" WHERE "entityType" = $1 AND "entityId" = $2`,
    [emEntityType(entityType, kind), entityId]
  );
}

/** Freshness is decided in SQL against the DB clock; `since` comes from `dbNow()`. */
export function getFreshEm(entityType: string, entityId: number, kind: EmRowKind, since: Date) {
  return one<EmRow>(
    `SELECT ${EM_COLUMNS} FROM "EntityModeration"
     WHERE "entityType" = $1 AND "entityId" = $2 AND "updatedAt" > ${utcParam(3)}`,
    [emEntityType(entityType, kind), entityId, since.toISOString()]
  );
}

export async function waitForTextScan(args: {
  entityType: string;
  entityId: number;
  kind: EmRowKind;
  since: Date;
  afterWorkflowId?: string | null;
}): Promise<EmRow> {
  const key = `${emEntityType(args.entityType, args.kind)}/${args.entityId}`;
  return waitFor(
    `text scan ${key}`,
    async () => {
      const row = await getFreshEm(args.entityType, args.entityId, args.kind, args.since);
      const state = classifyScanRow(row, args.afterWorkflowId);
      if (state === 'done') return { done: true, value: row! };
      // Nothing retries locally: the retry cron is only ever called by the deployed scheduler.
      if (state === 'failed')
        throw new Error(`text scan ${key} ended ${row!.status}: ${JSON.stringify(row!.result)}`);
      return {
        done: false,
        observed: row ?? (await getEm(args.entityType, args.entityId, args.kind)) ?? null,
      };
    },
    { timeoutMs: SCAN_TIMEOUT_MS, intervalMs: 3_000 }
  );
}

/**
 * The ChatMessage EM row is keyed on the window's newest message id — a window being one
 * sender's messages in one chat.
 */
export async function chatWindowEmId(chatId: number, senderId: number) {
  const row = await one<{ id: number | null }>(
    `SELECT max(id) AS id FROM "ChatMessage" WHERE "chatId" = $1 AND "userId" = $2`,
    [chatId, senderId]
  );
  if (!row?.id) throw new Error(`chat ${chatId} has no messages from user ${senderId}`);
  return row.id;
}
