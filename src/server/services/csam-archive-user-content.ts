import type { DB } from '@civitai/db-schema/kysely';
import { sql, type Kysely } from 'kysely';

/**
 * Rows fetched per round-trip by the cursor-paged scans that feed an evidence bundle.
 *
 * The number is a round-trip/latency trade, not a correctness one: any positive value produces
 * the same rows in the same order. It only has to be small enough that one page of full `Image`
 * rows is comfortably resident, which is the whole reason the scans are paged.
 *
 * Exported so the tests can size their fixtures to cross a real page boundary. A test that
 * hardcodes 500 goes green-and-vacuous the day this number is raised — it would be measuring a
 * single-page scan while claiming to measure a multi-page one.
 */
export const ARCHIVE_SCAN_PAGE_SIZE = 500;

/**
 * Keyset-pages a query over an ascending integer primary key, yielding one page at a time.
 *
 * Keyset rather than `skip`/`offset` because offset paging over a large table both degrades
 * quadratically and can skip or duplicate rows if the underlying set shifts between pages. With
 * `id > cursor ORDER BY id ASC` every row appears exactly once, and the pages concatenate to
 * exactly the row set a single unpaged query with the same filter would have returned.
 *
 * ⚠️ PRECONDITION: paging is only cheap where an index serves the caller's filter. For the
 * user-content readers, see `userContentReaders`; for the base bundle, see its writer in
 * csam.service-new.ts.
 *
 * Lazy: the first query is not issued until the generator is first pulled from. Callers depend on
 * that.
 */
export async function* scanPagesById<T extends { id: number }>(
  fetchPage: (args: { afterId: number | undefined; take: number }) => Promise<T[]>,
  pageSize: number = ARCHIVE_SCAN_PAGE_SIZE
): AsyncGenerator<T[], void, undefined> {
  let afterId: number | undefined;
  for (;;) {
    const rows = await fetchPage({ afterId, take: pageSize });
    if (!rows.length) return;
    yield rows;
    // A short page is the last page: there is no id greater than the one we just read.
    if (rows.length < pageSize) return;
    afterId = rows[rows.length - 1].id;
  }
}

/** Flattens paged rows into a per-row async iterable. Also lazy. */
export async function* flattenPages<T>(
  pages: AsyncIterable<T[]>
): AsyncGenerator<T, void, undefined> {
  for await (const page of pages) for (const row of page) yield row;
}

type Db = Kysely<DB>;
type Reader = (db: Db, userId: number, pageSize?: number) => AsyncIterable<unknown>;

/**
 * Text the reported user wrote, one reader per table, each selecting a fixed column list so a new
 * column never reaches the archive unreviewed. `serviceOfferings` also carries the removal fields a
 * moderator sets, which record why an offering's text was taken down. Rows are written as stored:
 * nothing is recovered from any other store. A profile clear leaves nothing on the row, so `profile`
 * names the hold decisions that cleared it in `blankedReasons`. A clear from the moderator endpoint
 * leaves no database record, so an empty list does not prove the profile was never cleared.
 *
 * Index posture, read off the database rather than the Prisma schema: `Post`, `Article` and
 * `BountyEntry` have `userId` indexes the schema does not declare; `Collection` and `ChatMember`
 * have declared `userId` btree indexes, `Bounty` and `ResourceReview` hash indexes;
 * `ServiceOffering` has `(sellerId, status)`. `PostText`, `Question` and `Answer` have none and
 * are small. For `ChatMessage`, see `chatMessages`. All reads use the read pool.
 */
export const userContentReaders: { name: string; rows: Reader }[] = [
  {
    name: 'posts',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('Post')
            .select(['id', 'userId', 'title', 'detail', 'createdAt', 'updatedAt', 'publishedAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'postTexts',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('PostText')
            .select([
              'id',
              'postId',
              'userId',
              'index',
              'content',
              'csamHeld',
              'createdAt',
              'updatedAt',
            ])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'articles',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('Article')
            .select(['id', 'userId', 'title', 'content', 'createdAt', 'updatedAt', 'publishedAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  { name: 'chatMessages', rows: (db, userId, pageSize) => chatMessages(db, userId, pageSize) },
  {
    name: 'profile',
    rows: async function* (db, userId) {
      const [profiles, decisions] = await Promise.all([
        db
          .selectFrom('UserProfile')
          .select([
            'userId',
            'bio',
            'message',
            'messageAddedAt',
            'sfwBio',
            'sfwMessage',
            'location',
          ])
          .where('userId', '=', userId)
          .execute(),
        // Every decision but a dismissal confirms the hold and clears the profile's text fields.
        db
          .selectFrom('TextScanHold')
          .select(['id', 'decidedAt', sql<string | null>`"meta"->>'decision'`.as('decision')])
          .where('label', '=', 'csam')
          .where('entityType', '=', 'UserProfile')
          .where('entityId', '=', userId)
          .where('status', '=', 'Confirmed')
          .orderBy('id', 'asc')
          .execute(),
      ]);
      const blankedReasons = decisions.map(
        ({ id, decidedAt, decision }) =>
          `blanked by decision ${decision ?? 'unknown'} on hold ${id} at ${
            decidedAt?.toISOString() ?? 'an unknown time'
          }`
      );
      for (const profile of profiles) yield { ...profile, blankedReasons };
    },
  },
  {
    name: 'resourceReviews',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('ResourceReview')
            .select(['id', 'userId', 'modelId', 'modelVersionId', 'details', 'createdAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'collections',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('Collection')
            .select(['id', 'userId', 'name', 'description', 'createdAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'bounties',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('Bounty')
            .select(['id', 'userId', 'name', 'description', 'details', 'createdAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'bountyEntries',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('BountyEntry')
            .select(['id', 'userId', 'bountyId', 'description', 'createdAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'serviceOfferings',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('ServiceOffering')
            .select([
              'id',
              'sellerId',
              'title',
              'description',
              'removedReason',
              'removedDetails',
              'removedAt',
              'createdAt',
            ])
            .where('sellerId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'questions',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('Question')
            .select(['id', 'userId', 'title', 'content', 'createdAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
  {
    name: 'answers',
    rows: (db, userId, pageSize) =>
      flattenPages(
        scanPagesById(({ afterId, take }) => {
          let q = db
            .selectFrom('Answer')
            .select(['id', 'questionId', 'userId', 'content', 'createdAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'asc')
            .limit(take);
          if (afterId !== undefined) q = q.where('id', '>', afterId);
          return q.execute();
        }, pageSize)
      ),
  },
];

const CHAT_MESSAGE_COLUMNS = [
  'id',
  'chatId',
  'userId',
  'content',
  'createdAt',
  'editedAt',
  'deletedAt',
  'referenceMessageId',
] as const;

/**
 * Every message, from either side and including deleted ones, in each chat the user has a
 * membership row in, whatever its status, in chat then id order; then, in id order, every message
 * the user wrote in a chat they have no membership row in. Each carries the text its edits replaced.
 *
 * Member chats are paged per chat. The `(chatId, id)` index is partial on undeleted messages, so it
 * cannot serve this read: each page sorts the chat's messages, which only a very long chat feels.
 * The user's other messages need a primary-key walk filtered on `userId`, since no index leads
 * with it; the cursor resumes, so that is about one pass over the table across all pages.
 */
async function* chatMessages(db: Db, userId: number, pageSize?: number) {
  const memberships = await db
    .selectFrom('ChatMember')
    .select('chatId')
    .where('userId', '=', userId)
    .orderBy('chatId', 'asc')
    .execute();
  const memberChats = [...new Set(memberships.map((m) => m.chatId))];
  for (const chatId of memberChats)
    yield* withEdits(
      db,
      userId,
      scanPagesById(({ afterId, take }) => {
        let q = db
          .selectFrom('ChatMessage')
          .select(CHAT_MESSAGE_COLUMNS)
          .where('chatId', '=', chatId)
          .orderBy('id', 'asc')
          .limit(take);
        if (afterId !== undefined) q = q.where('id', '>', afterId);
        return q.execute();
      }, pageSize)
    );
  yield* withEdits(
    db,
    userId,
    scanPagesById(({ afterId, take }) => {
      let q = db
        .selectFrom('ChatMessage')
        .select(CHAT_MESSAGE_COLUMNS)
        .where('userId', '=', userId)
        .orderBy('id', 'asc')
        .limit(take);
      if (memberChats.length) q = q.where('chatId', 'not in', memberChats);
      if (afterId !== undefined) q = q.where('id', '>', afterId);
      return q.execute();
    }, pageSize)
  );
}

/** Tags each message with its author side and the text each edit replaced, a page at a time. */
async function* withEdits<T extends { id: number; userId: number }>(
  db: Db,
  userId: number,
  pages: AsyncIterable<T[]>
) {
  for await (const page of pages) {
    // An edit overwrites `content`; the text it replaced is kept only here.
    const edits = await db
      .selectFrom('ChatMessageEdit')
      .select(['id', 'messageId', 'editorId', 'previousContent', 'createdAt'])
      .where(
        'messageId',
        'in',
        page.map((m) => m.id)
      )
      .orderBy('messageId', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const editsOf = new Map<number, Omit<(typeof edits)[number], 'messageId'>[]>();
    for (const { messageId, ...edit } of edits) {
      const list = editsOf.get(messageId) ?? [];
      list.push(edit);
      editsOf.set(messageId, list);
    }
    for (const row of page)
      yield {
        ...row,
        isReportedUser: row.userId === userId,
        previousVersions: editsOf.get(row.id) ?? [],
      };
  }
}
