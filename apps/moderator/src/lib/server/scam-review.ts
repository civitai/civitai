import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { dbRead } from './db';
import { convertHtml } from './html-to-text';
import { mapBounded } from './bounded';
import { parseQuery } from './query';
import { banConfirmed, resolveRestriction, setBanned } from './user-actions.service';
import { retryRateLimited } from './rate-limit-retry';
import { getGenerationRestrictions, type RestrictionRow } from './user-restriction.service';

/**
 * The scam queue as a bulk review: a page of pending scam restrictions, each with the text the scan
 * read, ticked by default. Nearly every row is a scam account, so a moderator reads down the page and
 * unticks the few that are not; one submit bans the ticked as spam and lifts the restriction on the rest.
 */

export const SCAM_PAGE_SIZE = 50;

/** One piece of scanned text, headed as the scan headed it. */
export type ScannedField = { heading: string; text: string };

export type ScamReviewRow = RestrictionRow & { scanned: ScannedField[] };

/**
 * What the text scan reads for each entity type it raises scam on, re-read now: the trigger stores the
 * entity and a hash of the text, never the text. Mirrors the main app's scan profiles
 * (`src/server/services/text-scan/profiles/{user-profile,user}.profile.ts`), so the headings match what
 * the classifier saw, as far as the content has not changed since.
 */
const PROFILE_FIELDS = [
  ['bio', 'Bio'],
  ['message', 'Profile announcement'],
  ['sfwBio', 'Bio (SFW domain)'],
  ['sfwMessage', 'Profile announcement (SFW domain)'],
] as const;

// Link targets kept, as the scan keeps them: where a link points is usually the scam.
const ANCHOR_HREF = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
const scannedText = (html: string | null | undefined) =>
  html
    ? convertHtml(
        html.replace(ANCHOR_HREF, (tag, dq?: string, sq?: string, bare?: string) => {
          const href = dq ?? sq ?? bare;
          return href ? `${tag} [link: ${href}] ` : tag;
        })
      ).text.trim()
    : '';

async function loadScannedText(rows: RestrictionRow[]): Promise<Map<number, ScannedField[]>> {
  const ids = (type: string) => [
    ...new Set(
      rows.flatMap((r) =>
        r.triggers.flatMap((t) => (t.entityType === type && t.entityId ? [t.entityId] : []))
      )
    ),
  ];
  const [profiles, users, comments, commentsV2] = await Promise.all([
    ids('UserProfile').length
      ? dbRead
          .selectFrom('UserProfile')
          .select(['userId', 'bio', 'message', 'sfwBio', 'sfwMessage'])
          .where('userId', 'in', ids('UserProfile'))
          .execute()
      : [],
    ids('User').length
      ? dbRead
          .selectFrom('User')
          .select(['id', 'username'])
          .where('id', 'in', ids('User'))
          .execute()
      : [],
    ids('Comment').length
      ? dbRead
          .selectFrom('Comment')
          .select(['id', 'content'])
          .where('id', 'in', ids('Comment'))
          .execute()
      : [],
    ids('CommentV2').length
      ? dbRead
          .selectFrom('CommentV2')
          .select(['id', 'content'])
          .where('id', 'in', ids('CommentV2'))
          .execute()
      : [],
  ]);

  const byEntity = new Map<string, ScannedField[]>();
  for (const p of profiles)
    byEntity.set(
      `UserProfile:${p.userId}`,
      PROFILE_FIELDS.map(([key, heading]) => ({ heading, text: scannedText(p[key]) }))
    );
  for (const u of users)
    byEntity.set(`User:${u.id}`, [{ heading: 'Username', text: u.username ?? '' }]);
  for (const c of comments)
    byEntity.set(`Comment:${c.id}`, [{ heading: 'Comment', text: scannedText(c.content) }]);
  for (const c of commentsV2)
    byEntity.set(`CommentV2:${c.id}`, [{ heading: 'Comment', text: scannedText(c.content) }]);

  const out = new Map<number, ScannedField[]>();
  for (const row of rows) {
    const seen = new Set<string>();
    const fields: ScannedField[] = [];
    for (const t of row.triggers) {
      const key = `${t.entityType}:${t.entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(...(byEntity.get(key) ?? []).filter((f) => f.text));
    }
    out.set(row.id, fields);
  }
  return out;
}

const querySchema = z.object({
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
});

export async function scamReviewLoad(url: URL) {
  const { q, page } = parseQuery(url, querySchema);
  const asId = Number(q);
  const isUserId = q !== '' && Number.isInteger(asId) && asId > 0;
  const { items, totalCount } = await getGenerationRestrictions({
    page,
    limit: SCAM_PAGE_SIZE,
    type: 'scam',
    status: 'Pending',
    username: !isUserId && q ? q : undefined,
    userId: isUserId ? asId : undefined,
  });
  // The text is the evidence; a failed read must say so rather than show an account with nothing.
  let scanned = new Map<number, ScannedField[]>();
  let textFailed = false;
  try {
    scanned = await loadScannedText(items);
  } catch (err) {
    console.error('Scam review: scanned text failed', err);
    textFailed = true;
  }
  return {
    rows: items.map((r): ScamReviewRow => ({ ...r, scanned: scanned.get(r.id) ?? [] })),
    textFailed,
    totalCount,
    page,
    hasMore: page * SCAM_PAGE_SIZE < totalCount,
    offset: (page - 1) * SCAM_PAGE_SIZE,
    q,
    fullBleed: true,
    headerInline: true,
  };
}

const BAN_NOTE = 'Scam review: banned as a scam account.';
const CLEAR_NOTE = 'Scam review: not a scam account.';
const ALREADY_BANNED_NOTE = 'Scam review: a scam account, already banned.';
/** Covers one rate-limit window. */
const RULE_BUDGET_MS = 75_000;
/** At most this many bans in flight: each is a call to the main app, which then works asynchronously. */
const CONCURRENCY = 5;

const idList = z.array(z.coerce.number().int().positive()).max(SCAM_PAGE_SIZE);

type Failure = { id: number; username: string | null; error: string };

/**
 * Bans every `ban` id as spam (content removed) and upholds its restriction; overturns every `clear` id,
 * which lifts its mute. Each restriction is re-read here: only a pending scam restriction is acted on,
 * and the account banned is the restriction's owner, never one the form names.
 *
 * Bans go out first, then are confirmed, then ruled, so the page's bans wait on one another's
 * confirmation once rather than one after another. A ban not confirmed in time is NOT upheld — the row
 * stays pending, as the single-row ban leaves it.
 */
export async function scamBulkRule({ request, locals }: RequestEvent) {
  const form = await request.formData();
  const banIds = idList.safeParse(form.getAll('ban'));
  const clearIds = idList.safeParse(form.getAll('clear'));
  if (!banIds.success || !clearIds.success) return fail(400, { error: 'Bad selection.' });
  if (!banIds.data.length && !clearIds.data.length)
    return fail(400, { error: 'Nothing to rule on.' });
  if (banIds.data.length && !locals.grants['audit.ban.execute'])
    return fail(403, {
      error: 'Banning needs the "Ban an account from an audit queue" permission.',
    });

  const all = [...banIds.data, ...clearIds.data];
  const rows = await dbRead
    .selectFrom('UserRestriction as r')
    .leftJoin('User as u', 'u.id', 'r.userId')
    .select(['r.id', 'r.userId', 'r.type', 'r.status', 'u.username', 'u.bannedAt'])
    .where('r.id', 'in', all)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const failed: Failure[] = [];
  const usable = (id: number) => {
    const row = byId.get(id);
    if (row?.type === 'scam' && row.status === 'Pending') return row;
    failed.push({
      id,
      username: row?.username ?? null,
      error: row ? 'No longer pending.' : 'Not found.',
    });
    return null;
  };
  const ticked = banIds.data.flatMap((id) => usable(id) ?? []);
  // `setBanned` refuses an account already banned; rule those restrictions without banning.
  const alreadyBanned = ticked.filter((row) => row.bannedAt);
  const toBan = ticked.filter((row) => !row.bannedAt);
  const toClear = clearIds.data.flatMap((id) => usable(id) ?? []);
  const moderatorId = locals.user.id;

  const sent = await mapBounded(
    toBan,
    async (row) => {
      const result = await setBanned({
        userId: row.userId,
        ban: true,
        reasonCode: 'SpamBot',
        detailsInternal: BAN_NOTE,
        removeMedia: true,
        removeModels: true,
        removeComments: true,
        moderatorId,
      });
      return result.ok ? null : result.error;
    },
    { concurrency: CONCURRENCY, budgetMs: 60_000 }
  );
  const accepted = toBan.filter((row, i) => {
    if (sent[i] === null) return true;
    failed.push({ id: row.id, username: row.username, error: sent[i] ?? 'The ban timed out.' });
    return false;
  });

  const confirmed = await Promise.all(accepted.map((row) => banConfirmed(row.userId)));
  const toUphold = accepted.filter((row, i) => {
    if (confirmed[i]) return true;
    failed.push({
      id: row.id,
      username: row.username,
      error: 'Ban accepted but not yet in effect; the restriction was NOT resolved.',
    });
    return false;
  });

  const ruleBy = Date.now() + RULE_BUDGET_MS;
  const rule = (status: 'Upheld' | 'Overturned') => async (row: (typeof rows)[number]) => {
    const note =
      status === 'Overturned' ? CLEAR_NOTE : row.bannedAt ? ALREADY_BANNED_NOTE : BAN_NOTE;
    const result = await retryRateLimited(
      () =>
        resolveRestriction({
          userRestrictionId: row.id,
          status,
          resolvedReason: 'other',
          internalNotes: note,
          userId: row.userId,
          moderatorId,
        }),
      ruleBy
    );
    return result.ok ? null : result.error;
  };
  const [upheld, cleared] = await Promise.all([
    mapBounded([...alreadyBanned, ...toUphold], rule('Upheld'), {
      concurrency: CONCURRENCY,
      budgetMs: RULE_BUDGET_MS,
    }),
    mapBounded(toClear, rule('Overturned'), {
      concurrency: CONCURRENCY,
      budgetMs: RULE_BUDGET_MS,
    }),
  ]);
  const settle = (list: typeof rows, results: (string | null | undefined)[], prefix: string) =>
    list.filter((row, i) => {
      if (results[i] === null) return true;
      failed.push({
        id: row.id,
        username: row.username,
        error: `${prefix}${results[i] ?? 'timed out.'}`,
      });
      return false;
    }).length;

  return {
    banned: settle(
      [...alreadyBanned, ...toUphold],
      upheld,
      'Banned, but the restriction was not resolved: '
    ),
    cleared: settle(toClear, cleared, 'Not cleared: '),
    failed,
  };
}
