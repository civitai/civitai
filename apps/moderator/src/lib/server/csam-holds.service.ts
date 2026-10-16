import { dbRead } from './db';
import { callModEndpoint } from './user-actions.service';

export type CsamHoldRow = {
  id: number;
  entityType: string;
  entityId: number;
  userId: number | null;
  username: string | null;
  text: string;
  reason: string;
  workflowId: string | null;
  promptId: number | null;
  contentAt: Date | null;
  createdAt: Date;
  chatId: number | null;
};

// Must match the sidebar's `csamTextHolds` predicate in `sidebar-counts.service.ts`.
const pendingCsamHolds = (entityType?: string) => {
  let query = dbRead
    .selectFrom('TextScanHold as h')
    .where('h.label', '=', 'csam')
    .where('h.status', '=', 'Pending');
  if (entityType) query = query.where('h.entityType', '=', entityType);
  return query;
};

export async function listPendingCsamHolds({
  limit,
  offset,
  entityType,
}: {
  limit: number;
  offset: number;
  entityType?: string;
}): Promise<{ items: CsamHoldRow[]; hasMore: boolean }> {
  const rows = await pendingCsamHolds(entityType)
    .leftJoin('User as u', 'u.id', 'h.userId')
    .select([
      'h.id',
      'h.entityType',
      'h.entityId',
      'h.userId',
      'u.username',
      'h.text',
      'h.reason',
      'h.workflowId',
      'h.promptId',
      'h.contentAt',
      'h.createdAt',
      'h.meta',
    ])
    .orderBy('h.createdAt', 'asc')
    .orderBy('h.id', 'asc')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const items = rows.slice(0, limit).map(({ meta, ...row }) => {
    const chatId = (meta as { chatId?: unknown } | null)?.chatId;
    return {
      ...row,
      username: row.username ?? null,
      chatId: typeof chatId === 'number' ? chatId : null,
    };
  });
  return { items, hasMore: rows.length > limit };
}

export async function countPendingCsamHolds(entityType?: string): Promise<number> {
  const row = await pendingCsamHolds(entityType)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type CsamHoldDecisionResult = { ok: true } | { ok: false; error: string };

/** The main app owns the write and refuses a hold that is no longer pending. */
export async function dismissCsamHold({
  holdId,
  note,
}: {
  holdId: number;
  note?: string;
}): Promise<CsamHoldDecisionResult> {
  const result = await callModEndpoint(
    'text-scan/csam-hold/resolve',
    { holdId, decision: 'dismiss', ...(note ? { note } : {}) },
    'Dismiss hold'
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (result.body.status !== 'Dismissed')
    return { ok: false, error: 'The main app did not report the hold as dismissed.' };
  return { ok: true };
}
