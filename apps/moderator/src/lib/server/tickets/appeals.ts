import { sql } from 'kysely';
import { dbRead } from '../db';
import {
  APPEAL_ROWS,
  APPEAL_WINDOW_DAYS,
  appealQueuePath,
  classifyAppeal,
  type AppealKind,
} from '$lib/tickets/appeals';
import { mentionKeys } from '$lib/tickets/mentions';

/** Rows read before the viewer's grants and the cut: a viewer who holds few queues must still fill the list. */
const FETCH_ROWS = 100;

export type TicketAppeal = {
  id: number;
  kind: AppealKind;
  entityType: string;
  entityId: number;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedReason: string | null;
  resolvedMessage: string | null;
  /** The ticket's subject or description links to this appeal's content. */
  mentioned: boolean;
  /** Pending and a plain image appeal, which the image appeals grant already shown it for: the only rows the card offers a ruling for. */
  rulable: boolean;
};

export type TicketAppeals =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | { status: 'ok'; userId: number; appeals: TicketAppeal[]; truncated: boolean };

type AppealRow = {
  id: number;
  entityType: string;
  entityId: number;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  resolvedMessage: string | null;
  entityRemovedAt: Date | null;
  category: string | null;
};

export type AppealReads = {
  appealsOf: (userId: number, since: Date, limit: number) => Promise<AppealRow[]>;
  /** Which of `imageIds` sit in `postIds`. */
  imagesOfPosts: (
    postIds: number[],
    imageIds: number[]
  ) => Promise<{ id: number; postId: number }[]>;
};

const liveReads: AppealReads = {
  // The userId index finds the user's appeals; the window is a filter over a handful of rows.
  appealsOf: (userId, since, limit) =>
    dbRead
      .selectFrom('Appeal')
      .select([
        'id',
        'entityType',
        'entityId',
        'status',
        'createdAt',
        'resolvedAt',
        'resolvedReason',
        'resolvedMessage',
        'entityRemovedAt',
        'category',
      ])
      .where('userId', '=', userId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'Pending'),
          eb('createdAt', '>=', since),
          eb('resolvedAt', '>=', since),
        ])
      )
      // Pending first, so the bounded read never drops one behind a busy window of decided appeals.
      .orderBy(sql`("status" = 'Pending') desc`)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute(),
  imagesOfPosts: async (postIds, imageIds) =>
    (
      await dbRead
        .selectFrom('Image')
        .select(['id', 'postId'])
        .where('id', 'in', imageIds)
        .where('postId', 'in', postIds)
        .execute()
    ).flatMap((r) => (r.postId === null ? [] : [{ id: r.id, postId: r.postId }])),
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The linked user's appeals: every pending one plus those filed or decided in the last 30 days, pending
 * first, each newest first. Only kinds whose queue the viewer may open are listed. A failed read is the caller's to turn
 * into `unavailable`; a failed post lookup only costs the "mentioned" mark on post links.
 */
export async function appealsSectionFor(
  ticket: { userId: number; text: string; canRead: (path: string) => boolean; now?: Date },
  reads: AppealReads = liveReads
): Promise<Extract<TicketAppeals, { status: 'ok' }>> {
  const now = ticket.now ?? new Date();
  const since = new Date(now.getTime() - APPEAL_WINDOW_DAYS * 86_400_000);
  const rows = await reads.appealsOf(ticket.userId, since, FETCH_ROWS);

  const visible = rows.flatMap((row) => {
    const kind = classifyAppeal(row);
    const path = kind && appealQueuePath(kind, row.category);
    return kind && path && ticket.canRead(path) ? [{ row, kind }] : [];
  });
  const shown = visible.slice(0, APPEAL_ROWS);

  const mentions = mentionKeys(ticket.text);
  const imageIds = shown.filter((a) => a.row.entityType === 'Image').map((a) => a.row.entityId);
  let viaPost = new Set<number>();
  if (mentions.posts.size > 0 && imageIds.length > 0) {
    try {
      const found = await reads.imagesOfPosts([...mentions.posts], imageIds);
      viaPost = new Set(found.map((i) => i.id));
    } catch (e) {
      console.error('[tickets] post lookup for appeals failed', e);
    }
  }
  const mentioned = (type: string, id: number) =>
    (type === 'Image' && (mentions.images.has(id) || viaPost.has(id))) ||
    (type === 'Model' && mentions.models.has(id));

  return {
    status: 'ok',
    userId: ticket.userId,
    truncated: visible.length > APPEAL_ROWS || rows.length >= FETCH_ROWS,
    appeals: shown.map(({ row, kind }) => ({
      id: row.id,
      kind,
      entityType: row.entityType,
      entityId: row.entityId,
      status: row.status,
      createdAt: iso(row.createdAt)!,
      resolvedAt: iso(row.resolvedAt),
      resolvedReason: row.resolvedReason,
      resolvedMessage: row.resolvedMessage,
      mentioned: mentioned(row.entityType, row.entityId),
      rulable: kind === 'image' && row.status === 'Pending',
    })),
  };
}
