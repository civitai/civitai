import { sql } from '@civitai/db/kysely';
import { NotificationCategory } from '@civitai/notifications';
import type { SiteAppealCategory, SiteAppealContext } from '@civitai/shared/site-appeal';
import { ArticleStatus } from '$lib/articles';
import { moderateArticle } from './article-moderation';
import { civitaiAppUrl } from './civitai-url';
import { dbRead, dbWrite } from './db';
import { siteAppealResolutionEmail } from './emails/appeal-resolution.email';
import { recordModActivity } from './mod-activity';
import { getNotifications } from './notifications';
import { callModEndpoint, setBanned, setMuted } from './user-actions.service';

export type SiteAppealDecision = 'Approved' | 'Rejected';

// The unpublish stamp the main app writes on both `Article.metadata` and `Model.meta`.
type UnpublishMeta = {
  unpublishedReason?: string | null;
  customMessage?: string | null;
  unpublishedAt?: string | null;
} | null;

type QueueRow = {
  id: number;
  userId: number;
  username: string | null;
  entityType: string;
  entityId: number;
  appealMessage: string;
  context: SiteAppealContext | null;
  createdAt: Date;
};

export type PriorAppeal = {
  id: number;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  resolvedMessage: string | null;
  internalNotes: string | null;
  resolvedBy: number | null;
};

/** What the appealed thing looks like NOW, which is what a ruling acts on. */
export type SiteAppealSubject =
  | {
      kind: 'account';
      bannedAt: Date | null;
      banReason: string | null;
      banDetailsExternal: string | null;
      banDetailsInternal: string | null;
      muted: boolean;
      muteExpiresAt: Date | null;
      muteReason: string | null;
    }
  | {
      kind: 'article';
      title: string | null;
      status: string | null;
      unpublishedReason: string | null;
      customMessage: string | null;
      unpublishedAt: string | null;
    }
  | {
      kind: 'model';
      name: string | null;
      status: string | null;
      deleted: boolean;
      unpublishedReason: string | null;
      customMessage: string | null;
      unpublishedAt: string | null;
    }
  | { kind: 'other' };

export type SiteAppealRow = QueueRow & { priors: PriorAppeal[]; subject: SiteAppealSubject };

// Binding `category` and `status` as the enums, never `::text`, keeps
// "Appeal_category_status_createdAt_idx" (category, status, createdAt, id) usable.
const pending = (category: SiteAppealCategory) =>
  dbRead
    .selectFrom('Appeal as a')
    .where('a.category', '=', category)
    .where('a.status', '=', 'Pending');

export async function countSiteAppeals(): Promise<Record<SiteAppealCategory, number>> {
  const rows = await dbRead
    .selectFrom('Appeal')
    .select(['category', (eb) => eb.fn.countAll<string>().as('count')])
    .where('category', 'is not', null)
    .where('status', '=', 'Pending')
    .groupBy('category')
    .execute();
  const out: Record<SiteAppealCategory, number> = { Account: 0, Article: 0, Model: 0, Other: 0 };
  for (const r of rows) if (r.category) out[r.category] = Number(r.count);
  return out;
}

export async function getSiteAppealQueue({
  category,
  limit,
  offset,
}: {
  category: SiteAppealCategory;
  limit: number;
  offset: number;
}): Promise<{ items: SiteAppealRow[]; hasMore: boolean }> {
  const rows = (await pending(category)
    .leftJoin('User as u', 'u.id', 'a.userId')
    .select([
      'a.id',
      'a.userId',
      'u.username',
      'a.entityType',
      'a.entityId',
      'a.appealMessage',
      'a.context',
      'a.createdAt',
    ])
    .orderBy('a.createdAt', 'asc')
    .orderBy('a.id', 'asc')
    .limit(limit + 1)
    .offset(offset)
    .execute()) as QueueRow[];
  const page = rows.slice(0, limit);

  const [priors, subjects] = await Promise.all([
    getPriorAppeals(category, page),
    getSubjects(category, page),
  ]);
  return {
    hasMore: rows.length > limit,
    items: page.map((row) => ({
      ...row,
      priors: priors.get(priorKey(row))?.filter((p) => p.id !== row.id) ?? [],
      subject: subjects.get(row.entityId) ?? missingSubject(category),
    })),
  };
}

export async function countSiteAppealQueue(category: SiteAppealCategory): Promise<number> {
  const row = await pending(category)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** The subject of an appeal whose article, model or account row no longer exists. */
function missingSubject(category: SiteAppealCategory): SiteAppealSubject {
  const unpublished = { unpublishedReason: null, customMessage: null, unpublishedAt: null };
  switch (category) {
    case 'Account':
      return {
        kind: 'account',
        bannedAt: null,
        banReason: null,
        banDetailsExternal: null,
        banDetailsInternal: null,
        muted: false,
        muteExpiresAt: null,
        muteReason: null,
      };
    case 'Article':
      return { kind: 'article', title: null, status: null, ...unpublished };
    case 'Model':
      return { kind: 'model', name: null, status: null, deleted: true, ...unpublished };
    case 'Other':
      return { kind: 'other' };
  }
}

const priorKey = (r: { userId: number; entityType: string; entityId: number }) =>
  `${r.userId}:${r.entityType}:${r.entityId}`;

/**
 * Earlier appeals by the same user about the same thing, so a re-file shows as one. Not for Other:
 * it keys on the appellant's own row, so every Other appeal they ever filed would read as a repeat.
 */
async function getPriorAppeals(
  category: SiteAppealCategory,
  rows: QueueRow[]
): Promise<Map<string, PriorAppeal[]>> {
  const out = new Map<string, PriorAppeal[]>();
  if (category === 'Other' || !rows.length) return out;
  const found = await dbRead
    .selectFrom('Appeal')
    .select([
      'id',
      'userId',
      'entityType',
      'entityId',
      'status',
      'createdAt',
      'resolvedAt',
      'resolvedReason',
      'resolvedMessage',
      'internalNotes',
      'resolvedBy',
    ])
    .where('category', '=', category)
    // Served by Appeal_entityType_entityId_userId_idx.
    .where((eb) =>
      eb.or(
        rows.map((r) =>
          eb.and([
            eb('entityType', '=', r.entityType as never),
            eb('entityId', '=', r.entityId),
            eb('userId', '=', r.userId),
          ])
        )
      )
    )
    .orderBy('id', 'desc')
    .execute();
  for (const { userId, entityType, entityId, ...prior } of found) {
    const key = priorKey({ userId, entityType, entityId });
    out.set(key, [...(out.get(key) ?? []), prior]);
  }
  return out;
}

async function getSubjects(
  category: SiteAppealCategory,
  rows: QueueRow[]
): Promise<Map<number, SiteAppealSubject>> {
  const ids = [...new Set(rows.map((r) => r.entityId))];
  const out = new Map<number, SiteAppealSubject>();
  if (!ids.length || category === 'Other') return out;

  if (category === 'Account') {
    const users = await dbRead
      .selectFrom('User')
      .select([
        'id',
        'bannedAt',
        'muted',
        'muteExpiresAt',
        sql<string | null>`meta #>> '{banDetails,reasonCode}'`.as('banReason'),
        sql<string | null>`meta #>> '{banDetails,detailsExternal}'`.as('banDetailsExternal'),
        sql<string | null>`meta #>> '{banDetails,detailsInternal}'`.as('banDetailsInternal'),
        sql<string | null>`meta ->> 'muteReason'`.as('muteReason'),
      ])
      .where('id', 'in', ids)
      .execute();
    for (const { id, ...u } of users) out.set(id, { kind: 'account', ...u });
  } else if (category === 'Article') {
    const articles = await dbRead
      .selectFrom('Article')
      .select(['id', 'title', 'status', 'metadata'])
      .where('id', 'in', ids)
      .execute();
    for (const a of articles) {
      const meta = a.metadata as UnpublishMeta;
      out.set(a.id, {
        kind: 'article',
        title: a.title,
        status: a.status,
        unpublishedReason: meta?.unpublishedReason ?? null,
        customMessage: meta?.customMessage ?? null,
        unpublishedAt: meta?.unpublishedAt ?? null,
      });
    }
  } else {
    const models = await dbRead
      .selectFrom('Model')
      .select(['id', 'name', 'status', 'deletedAt', 'meta'])
      .where('id', 'in', ids)
      .execute();
    for (const m of models) {
      const meta = m.meta as UnpublishMeta;
      out.set(m.id, {
        kind: 'model',
        name: m.name,
        status: m.status,
        deleted: m.deletedAt !== null,
        unpublishedReason: meta?.unpublishedReason ?? null,
        customMessage: meta?.customMessage ?? null,
        unpublishedAt: meta?.unpublishedAt ?? null,
      });
    }
  }
  return out;
}

type Lift = { ok: true; restored: boolean; lifted: string[] } | { ok: false; error: string };

const NOT_FOUND_USER = 'The account no longer exists.';

/** `/api/mod/ban-user` answers before it has unbanned, so read the primary until it has. */
async function unbanLanded(userId: number, attempts = 10): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await dbWrite
      .selectFrom('User')
      .select('bannedAt')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (row && row.bannedAt === null) return true;
  }
  return false;
}

async function liftAccount(userId: number, moderatorId: number, canBan: boolean): Promise<Lift> {
  const user = await dbWrite
    .selectFrom('User')
    .select(['bannedAt', 'muted'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return { ok: false, error: NOT_FOUND_USER };
  // Checked before anything lifts, so a refused unban cannot leave the mute half-lifted.
  if (user.bannedAt && !canBan)
    return { ok: false, error: 'Approving lifts a ban, which needs the Ban permission.' };

  const lifted: string[] = [];
  if (user.bannedAt) {
    const unban = await setBanned({ userId, ban: false, moderatorId });
    if (!unban.ok) return unban;
    if (!(await unbanLanded(userId)))
      return { ok: false, error: 'The unban did not land. Check the account, then try again.' };
    lifted.push('ban');
  }
  if (user.muted) {
    const unmute = await setMuted({ userId, muted: false, moderatorId });
    if (!unmute.ok)
      return {
        ok: false,
        error: lifted.length
          ? `Unbanned, but the mute was not lifted: ${unmute.error}`
          : unmute.error,
      };
    lifted.push('mute');
  }
  return { ok: true, restored: true, lifted };
}

async function liftArticle(articleId: number, moderatorId: number): Promise<Lift> {
  const article = await dbWrite
    .selectFrom('Article')
    .select('status')
    .where('id', '=', articleId)
    .executeTakeFirst();
  if (article?.status === ArticleStatus.Published) return { ok: true, restored: true, lifted: [] };
  // Anything but a moderator's unpublish (deleted, or unpublished by its owner) is not ours to put back.
  if (article?.status !== ArticleStatus.UnpublishedViolation)
    return { ok: true, restored: false, lifted: [] };
  const result = await moderateArticle({ action: 'restore', articleId, userId: moderatorId });
  return result.ok ? { ok: true, restored: true, lifted: ['article'] } : result;
}

async function liftModel(modelId: number): Promise<Lift> {
  const model = await dbWrite
    .selectFrom('Model')
    .select(['status', 'deletedAt'])
    .where('id', '=', modelId)
    .executeTakeFirst();
  if (model && !model.deletedAt && model.status === 'Published')
    return { ok: true, restored: true, lifted: [] };
  if (!model || model.deletedAt || model.status !== 'UnpublishedViolation')
    return { ok: true, restored: false, lifted: [] };
  const result = await callModEndpoint('model/republish', { modelId }, 'Republish');
  if (!result.ok) return result;
  return { ok: true, restored: result.body.status === 'Published', lifted: ['model'] };
}

function lift(
  category: SiteAppealCategory,
  appeal: { entityId: number },
  moderatorId: number,
  canBan: boolean
): Promise<Lift> {
  switch (category) {
    case 'Account':
      return liftAccount(appeal.entityId, moderatorId, canBan);
    case 'Article':
      return liftArticle(appeal.entityId, moderatorId);
    case 'Model':
      return liftModel(appeal.entityId);
    case 'Other':
      return Promise.resolve({ ok: true, restored: false, lifted: [] });
  }
}

export const SITE_APPEAL_ALREADY_DECIDED =
  'Another moderator already decided this appeal, or it is not in this queue. Reload.';

export type SiteAppealResolution =
  | { ok: true; lifted: string[]; restored: boolean }
  | { ok: false; error: string; conflict?: boolean };

/**
 * Decides one form appeal in `category`'s queue. Approving lifts what was appealed first, and the
 * appeal closes only once that worked: a failed lift leaves it Pending with nothing written.
 *
 * The row is locked for the whole decision, so a second moderator waits and then finds it decided
 * rather than lifting a second time. Nothing the lift calls writes `Appeal`, so the lock cannot
 * deadlock with it.
 */
export async function resolveSiteAppeal(input: {
  appealId: number;
  category: SiteAppealCategory;
  decision: SiteAppealDecision;
  resolvedReason: string;
  internalNotes?: string;
  resolvedMessage?: string;
  moderatorId: number;
  canBan: boolean;
}): Promise<SiteAppealResolution> {
  const result = await dbWrite.transaction().execute(async (trx) => {
    const appeal = await trx
      .selectFrom('Appeal')
      .select(['id', 'userId', 'entityType', 'entityId'])
      .where('id', '=', input.appealId)
      // The page's own category: a grant on one queue must not decide another queue's appeal.
      .where('category', '=', input.category)
      .where('status', '=', 'Pending')
      .forUpdate()
      .executeTakeFirst();
    if (!appeal) return { ok: false as const, error: SITE_APPEAL_ALREADY_DECIDED, conflict: true };

    const outcome: Lift =
      input.decision === 'Approved'
        ? await lift(input.category, appeal, input.moderatorId, input.canBan)
        : { ok: true, restored: false, lifted: [] };
    if (!outcome.ok) return outcome;

    const closed = await trx
      .updateTable('Appeal')
      .set({
        status: input.decision,
        resolvedBy: input.moderatorId,
        resolvedAt: new Date(),
        resolvedReason: input.resolvedReason,
        resolvedMessage: input.resolvedMessage ?? null,
        internalNotes: input.internalNotes ?? null,
      })
      .where('id', '=', appeal.id)
      .where('status', '=', 'Pending')
      .executeTakeFirst();
    if (Number(closed.numUpdatedRows ?? 0) !== 1)
      return { ok: false as const, error: SITE_APPEAL_ALREADY_DECIDED, conflict: true };
    return { ok: true as const, appeal, restored: outcome.restored, lifted: outcome.lifted };
  });
  if (!result.ok) return result;

  const { appeal, restored, lifted } = result;
  await recordModActivity({
    userId: input.moderatorId,
    entityType: appeal.entityType.toLowerCase(),
    entityId: appeal.entityId,
    activity: 'resolveAppeal',
  });
  await notifySiteAppealResolved({
    appeal,
    category: input.category,
    decision: input.decision,
    restored,
    resolvedMessage: input.resolvedMessage,
  });
  return { ok: true, lifted, restored };
}

async function notifySiteAppealResolved(input: {
  appeal: { id: number; userId: number; entityType: string; entityId: number };
  category: SiteAppealCategory;
  decision: SiteAppealDecision;
  restored: boolean;
  resolvedMessage?: string;
}): Promise<void> {
  const { appeal } = input;
  try {
    await getNotifications().createNotification({
      userId: appeal.userId,
      type: 'entity-appeal-resolved',
      category: NotificationCategory.Other,
      key: `entity-appeal-resolved:${appeal.entityType}:${appeal.entityId}:${appeal.id}`,
      details: {
        category: input.category,
        entityType: appeal.entityType,
        entityId: appeal.entityId,
        status: input.decision,
        restored: input.restored,
        resolvedMessage: input.resolvedMessage ?? '',
      },
    });
  } catch {
    // onFailure already logged; best-effort.
  }

  // A banned appellant cannot see in-app notifications, so the email is how they learn the outcome.
  try {
    const appellant = await dbRead
      .selectFrom('User')
      .select(['email', 'username'])
      .where('id', '=', appeal.userId)
      .executeTakeFirst();
    if (!appellant?.email) return;
    await siteAppealResolutionEmail.send({
      to: appellant.email,
      username: appellant.username ?? 'there',
      category: input.category,
      approved: input.decision === 'Approved',
      restored: input.restored,
      appealUrl: `${civitaiAppUrl()}/appeal`,
    });
  } catch (e) {
    console.error('site appeal email failed', { appealId: appeal.id, error: (e as Error).message });
  }
}
