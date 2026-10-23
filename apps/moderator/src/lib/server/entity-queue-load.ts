import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { canAccess } from './access';
import { readerOf } from './chat-read-audit';
import { getArticle } from './article-lookup.service';
import {
  chatMessageCounts,
  getChatMembers,
  getTranscript,
  type ChatMemberRow,
} from './chat-audit.service';
import { getImagesForCollection, getImagesForConnection } from './bulk-image.service';
import { articleBody } from './article-body';
import { cappedText } from './html-to-text';
import { loadItemReports } from './report-queue-load';
import { parseQueryKeys } from './query';
import { usersByIds } from './users.service';
import { z } from 'zod';
import type { ModeratorReportRow } from './reports.service';
import { ARTICLE_STATUS_NOTES } from '$lib/articles';
import {
  chatSubject,
  entryTitle,
  type EntityQueueType,
  type QueueSubject,
} from '$lib/entity-report-queues';

/**
 * The two reads each shared-layout report queue needs (`/reports/[queue=entityQueue]`): a SUBJECT for
 * every row on the queue page, so the list says what was reported and whose it is, and the open ITEM,
 * the evidence the middle column renders. Adding a type is a `case` in each switch here — both
 * check exhaustiveness, so a missing one fails the build — plus its labels and its preview in
 * `EntityView` (`docs/moderator-app/report-queue-pattern.md`).
 */

/** An article's, bounty's or entry's images read at once, newest first. Past it the grid drops its
 *  end-of-list line and the heading's total says how many there are; the site has the rest. */
const IMAGE_LIMIT = 200;
/** A collection's images, a page at a time — the user queue's page size. A collection can hold
 *  thousands (one open report's has 4,045), and a fixed window showed the newest 200 of them. */
export const COLLECTION_IMAGES_PER_PAGE = 60;

// The item's own key, read alone so paging the images reruns only the item, never the queue.
const itemQuerySchema = z.object({
  imgPage: z.coerce.number().int().positive().max(10_000).catch(1),
});
/** Characters of a bounty's or entry's text rendered. The site has the rest. */
const TEXT_LIMIT = 20_000;
const text = (html: string | null | undefined) => cappedText(html, TEXT_LIMIT);

const uniqueIds = (rows: { entityId: number | null }[]) => [
  ...new Set(rows.flatMap((r) => (r.entityId != null && r.entityId > 0 ? [r.entityId] : []))),
];

// ---------------------------------------------------------------------------------------------------
// Queue rows

export async function queueSubjects(
  type: EntityQueueType,
  rows: Pick<ModeratorReportRow, 'id' | 'entityId' | 'reportedById' | 'alsoReportedBy'>[]
): Promise<Map<number, QueueSubject>> {
  const ids = uniqueIds(rows);
  if (!ids.length) return new Map();
  const byEntity = await subjectsByEntity(type, ids);
  return new Map(
    rows.flatMap((r) => {
      const subject = r.entityId != null ? byEntity(r.entityId, r) : null;
      return subject ? [[r.id, subject] as const] : [];
    })
  );
}

type SubjectOf = (
  entityId: number,
  report: Pick<ModeratorReportRow, 'reportedById' | 'alsoReportedBy'>
) => QueueSubject | null;

async function subjectsByEntity(type: EntityQueueType, ids: number[]): Promise<SubjectOf> {
  switch (type) {
    case 'article': {
      const found = await dbRead
        .selectFrom('Article as a')
        .leftJoin('User as u', 'u.id', 'a.userId')
        .select(['a.id', 'a.title', 'a.status', 'a.userId', 'u.username', 'u.bannedAt'])
        .where('a.id', 'in', ids)
        .execute();
      const map = new Map(found.map((a) => [a.id, a]));
      return (id) => {
        const a = map.get(id);
        return a
          ? {
              title: a.title || `Article #${id}`,
              userId: a.userId,
              username: a.username,
              bannedAt: a.bannedAt,
              note: ARTICLE_STATUS_NOTES[String(a.status)] ?? null,
            }
          : null;
      };
    }

    case 'chat': {
      const [members, counts] = await Promise.all([
        dbRead
          .selectFrom('ChatMember as cm')
          .leftJoin('User as u', 'u.id', 'cm.userId')
          .select(['cm.chatId', 'cm.userId', 'u.username', 'u.bannedAt'])
          .where('cm.chatId', 'in', ids)
          .execute(),
        // Chat Audit's own count, so the row and the transcript agree on how many messages there are.
        chatMessageCounts(ids),
      ]);
      const byChat = new Map<number, typeof members>();
      for (const m of members) byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m]);
      return (id, report) => {
        const list = byChat.get(id) ?? [];
        const [subjectId] = chatSubject(list, [report]).subjectIds;
        const subject = list.find((m) => m.userId === subjectId);
        const n = counts.get(id)?.messages ?? 0;
        return {
          title: subject ? `Chat with ${subject.username ?? `#${subject.userId}`}` : `Chat #${id}`,
          userId: subject?.userId ?? null,
          username: subject?.username ?? null,
          bannedAt: subject?.bannedAt ?? null,
          note: `${list.length} members · ${n} ${n === 1 ? 'message' : 'messages'}`,
        };
      };
    }

    case 'collection': {
      const found = await dbRead
        .selectFrom('Collection as c')
        .leftJoin('User as u', 'u.id', 'c.userId')
        .select([
          'c.id',
          'c.name',
          'c.type',
          'c.userId',
          'u.username',
          'u.bannedAt',
          sql<number>`(SELECT count(*)::int FROM "CollectionItem" ci WHERE ci."collectionId" = c."id")`.as(
            'items'
          ),
        ])
        .where('c.id', 'in', ids)
        .execute();
      const map = new Map(found.map((c) => [c.id, c]));
      return (id) => {
        const c = map.get(id);
        return c
          ? {
              title: c.name || `Collection #${id}`,
              userId: c.userId,
              username: c.username,
              bannedAt: c.bannedAt,
              note: `${c.items} ${c.type ? `${String(c.type).toLowerCase()} ` : ''}${
                c.items === 1 ? 'item' : 'items'
              }`,
            }
          : null;
      };
    }

    case 'bounty': {
      const found = await dbRead
        .selectFrom('Bounty as b')
        .leftJoin('User as u', 'u.id', 'b.userId')
        .select([
          'b.id',
          'b.name',
          'b.type',
          'b.complete',
          'b.userId',
          'u.username',
          'u.bannedAt',
          sql<number>`(SELECT count(*)::int FROM "BountyEntry" e WHERE e."bountyId" = b."id")`.as(
            'entries'
          ),
        ])
        .where('b.id', 'in', ids)
        .execute();
      const map = new Map(found.map((b) => [b.id, b]));
      return (id) => {
        const b = map.get(id);
        return b
          ? {
              title: b.name || `Bounty #${id}`,
              userId: b.userId,
              username: b.username,
              bannedAt: b.bannedAt,
              note: `${b.entries} ${b.entries === 1 ? 'entry' : 'entries'}${
                b.complete ? ' · complete' : ''
              }`,
            }
          : null;
      };
    }

    case 'bountyEntry': {
      const found = await dbRead
        .selectFrom('BountyEntry as e')
        .innerJoin('Bounty as b', 'b.id', 'e.bountyId')
        .leftJoin('User as u', 'u.id', 'e.userId')
        .select([
          'e.id',
          'e.userId',
          'b.name as bountyName',
          'u.username',
          'u.bannedAt',
          sql<number>`(SELECT count(*)::int FROM "ImageConnection" ic WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" = e."id")`.as(
            'images'
          ),
        ])
        .where('e.id', 'in', ids)
        .execute();
      const map = new Map(found.map((e) => [e.id, e]));
      return (id) => {
        const e = map.get(id);
        return e
          ? {
              title: entryTitle(id, e.bountyName),
              userId: e.userId,
              username: e.username,
              bannedAt: e.bannedAt,
              note: `${e.images} ${e.images === 1 ? 'image' : 'images'}`,
            }
          : null;
      };
    }
  }
  // Exhaustive: a type added to ENTITY_QUEUE_TYPES without a case fails the build here.
  const unhandled: never = type;
  throw new Error(`No queue subject read for ${unhandled}`);
}

// ---------------------------------------------------------------------------------------------------
// The open item

async function articleItem(id: number) {
  const article = await getArticle(id);
  if (!article)
    return { kind: 'article' as const, article: null, body: null, images: null, ownerId: null };
  const [content, images] = await Promise.all([
    dbRead.selectFrom('Article').select('content').where('id', '=', id).executeTakeFirst(),
    // The cover is a column, not a connection, and is what decides the article's rating.
    getImagesForConnection(
      'Article',
      id,
      { limit: IMAGE_LIMIT },
      article.coverId ? [article.coverId] : []
    ),
  ]);
  return {
    kind: 'article' as const,
    article,
    body: articleBody(content?.content),
    images,
    ownerId: article.userId,
  };
}

async function chatItem(id: number, locals: App.Locals) {
  // 🔴 A transcript is private messages. Chat Audit is granted deliberately, and reaching the report
  // queue is a different, wider grant — so the queue shows WHO is in the chat, which a ruling needs,
  // and the words only to a moderator who could already read them in Chat Audit. And only for a chat
  // that was reported at all (at any status): the id is in the path, and without this any chat's
  // members were one typed URL away.
  const reported = await dbRead
    .selectFrom('ChatReport')
    .select('reportId')
    .where('chatId', '=', id)
    .limit(1)
    .executeTakeFirst();
  if (!reported)
    return {
      kind: 'chat' as const,
      reported: false,
      members: [] as ChatMemberRow[],
      canRead: false,
      transcript: null,
    };
  const canRead = canAccess(locals.user, '/retool/chat-audit');
  const [members, transcript] = await Promise.all([
    getChatMembers(id),
    canRead ? getTranscript(readerOf(locals.user), id) : null,
  ]);
  // Who the reports are about is worked out on the page (`chatSubject`), over the reports it lists —
  // resolved ones a status filter or a `?report=` link put on screen included, which this read's
  // open reports are not.
  return { kind: 'chat' as const, reported: true, members, canRead, transcript };
}

/**
 * One page of a collection's images. The page is clamped to the last one: a removal can shrink the
 * collection under a moderator on its last page, and an empty grid there reads as "nothing left".
 */
export async function collectionImages(id: number, page: number) {
  const perPage = COLLECTION_IMAGES_PER_PAGE;
  const at = (p: number) =>
    getImagesForCollection(id, { limit: perPage, offset: (p - 1) * perPage });
  let batch = await at(page);
  const last = Math.max(1, Math.ceil(batch.total / perPage));
  if (page > last) {
    page = last;
    batch = await at(page);
  }
  // A collection's images span posters, and a removal can strike every one of them: the page names
  // them so the strike box can.
  const ownerIds = [...new Set(batch.items.map((i) => i.userId))];
  const owners = [...(await usersByIds(ownerIds))].map(([id, u]) => ({ id, ...u }));
  return { ...batch, owners, page, perPage };
}

async function collectionItem(id: number, imgPage: number) {
  const collection = await dbRead
    .selectFrom('Collection as c')
    .leftJoin('User as u', 'u.id', 'c.userId')
    .select([
      'c.id',
      'c.name',
      'c.description',
      'c.type',
      'c.read',
      'c.write',
      'c.mode',
      'c.availability',
      'c.nsfwLevel',
      'c.createdAt',
      'c.userId',
      'u.username',
      'u.bannedAt as userBannedAt',
    ])
    .where('c.id', '=', id)
    .executeTakeFirst();
  if (!collection)
    return {
      kind: 'collection' as const,
      collection: null,
      images: null,
      others: [],
      othersTotal: 0,
      ownerId: null,
    };

  // A collection holds images, or posts, models and articles. The images are judged by looking at
  // them; the rest are listed, each linked to where it can be opened.
  const others = dbRead
    .selectFrom('CollectionItem as ci')
    .leftJoin('Model as m', 'm.id', 'ci.modelId')
    .leftJoin('Post as p', 'p.id', 'ci.postId')
    .leftJoin('Article as a', 'a.id', 'ci.articleId')
    .where('ci.collectionId', '=', id)
    .where('ci.imageId', 'is', null);
  const [images, otherRows, otherCount] = await Promise.all([
    collectionImages(id, imgPage),
    others
      .select([
        'ci.id',
        'ci.modelId',
        'ci.postId',
        'ci.articleId',
        'ci.model3dId',
        'ci.status',
        'm.name as modelName',
        'p.title as postTitle',
        'a.title as articleTitle',
      ])
      .orderBy('ci.id', 'desc')
      .limit(100)
      .execute(),
    others.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
  ]);
  return {
    kind: 'collection' as const,
    collection: {
      ...collection,
      type: collection.type ? String(collection.type) : null,
      read: String(collection.read),
      write: String(collection.write),
      mode: collection.mode ? String(collection.mode) : null,
      availability: String(collection.availability),
    },
    images,
    others: otherRows.map((r) => ({ ...r, status: String(r.status) })),
    othersTotal: Number(otherCount?.n ?? 0),
    ownerId: collection.userId,
  };
}

async function bountySummary(id: number) {
  return dbRead
    .selectFrom('Bounty as b')
    .leftJoin('User as u', 'u.id', 'b.userId')
    .select([
      'b.id',
      'b.name',
      'b.description',
      'b.type',
      'b.mode',
      'b.entryMode',
      'b.startsAt',
      'b.expiresAt',
      'b.createdAt',
      'b.complete',
      'b.refunded',
      'b.poi',
      'b.nsfw',
      'b.nsfwLevel',
      'b.availability',
      'b.userId',
      'u.username',
      'u.bannedAt as userBannedAt',
    ])
    .where('b.id', '=', id)
    .executeTakeFirst();
}

const bountyView = (b: NonNullable<Awaited<ReturnType<typeof bountySummary>>>) => ({
  ...b,
  description: text(b.description),
  type: String(b.type),
  mode: String(b.mode),
  entryMode: String(b.entryMode),
  availability: String(b.availability),
});

async function bountyItem(id: number) {
  const bounty = await bountySummary(id);
  if (!bounty)
    return {
      kind: 'bounty' as const,
      bounty: null,
      prize: [],
      entries: 0,
      images: null,
      ownerId: null,
    };
  const [prize, entries, images] = await Promise.all([
    // The pool as the site shows it: every benefactor's stake, per currency.
    dbRead
      .selectFrom('BountyBenefactor')
      .select([
        'currency',
        (eb) => eb.fn.sum<string>('unitAmount').as('amount'),
        (eb) => eb.fn.countAll<string>().as('benefactors'),
      ])
      .where('bountyId', '=', id)
      .groupBy('currency')
      .execute(),
    dbRead
      .selectFrom('BountyEntry')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('bountyId', '=', id)
      .executeTakeFirst(),
    getImagesForConnection('Bounty', id, { limit: IMAGE_LIMIT }),
  ]);
  return {
    kind: 'bounty' as const,
    bounty: bountyView(bounty),
    prize: prize.map((p) => ({
      currency: String(p.currency),
      amount: Number(p.amount ?? 0),
      benefactors: Number(p.benefactors),
    })),
    entries: Number(entries?.n ?? 0),
    images,
    ownerId: bounty.userId,
  };
}

async function bountyEntryItem(id: number) {
  const entry = await dbRead
    .selectFrom('BountyEntry as e')
    .leftJoin('User as u', 'u.id', 'e.userId')
    .select([
      'e.id',
      'e.bountyId',
      'e.description',
      'e.createdAt',
      'e.locked',
      'e.nsfwLevel',
      'e.userId',
      'u.username',
      'u.bannedAt as userBannedAt',
      sql<boolean>`EXISTS (SELECT 1 FROM "BountyBenefactor" bb WHERE bb."awardedToId" = e."id")`.as(
        'awarded'
      ),
    ])
    .where('e.id', '=', id)
    .executeTakeFirst();
  if (!entry)
    return { kind: 'bountyEntry' as const, entry: null, bounty: null, images: null, ownerId: null };
  const [bounty, images] = await Promise.all([
    bountySummary(entry.bountyId),
    getImagesForConnection('BountyEntry', id, { limit: IMAGE_LIMIT }),
  ]);
  return {
    kind: 'bountyEntry' as const,
    entry: { ...entry, description: text(entry.description) },
    // What the entry was submitted to is half of judging it — "used a pre-existing model" is a claim
    // about the bounty's rules.
    bounty: bounty ? bountyView(bounty) : null,
    images,
    ownerId: entry.userId,
  };
}

/**
 * The open item: its evidence, every open report about it, and (but for a chat, whose subject the page
 * works out) the account a strike or notification goes to (`ownerId`). Shared by the bare queue,
 * which opens its first item, and `[id]`.
 */
export async function loadEntityItem(
  type: EntityQueueType,
  id: number,
  locals: App.Locals,
  url: URL
) {
  const { imgPage } = parseQueryKeys(url, itemQuerySchema);
  const [reports, evidence] = await Promise.all([
    loadItemReports(type, id),
    itemEvidence(type, id, locals, imgPage),
  ]);
  return { id, type, reports, evidence };
}

function itemEvidence(type: EntityQueueType, id: number, locals: App.Locals, imgPage: number) {
  switch (type) {
    case 'article':
      return articleItem(id);
    case 'chat':
      return chatItem(id, locals);
    case 'collection':
      return collectionItem(id, imgPage);
    case 'bounty':
      return bountyItem(id);
    case 'bountyEntry':
      return bountyEntryItem(id);
  }
  // Exhaustive, as `subjectsByEntity` is: a new type without its read fails the build here rather
  // than loading as some other type's.
  const unhandled: never = type;
  throw new Error(`No item read for ${unhandled}`);
}

export type EntityItem = Awaited<ReturnType<typeof loadEntityItem>>;
export type EntityEvidence = EntityItem['evidence'];
