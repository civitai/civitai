import { CacheTTL } from '~/server/common/constants';
import { BlocklistType } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { UpsertBlocklistSchema } from '~/server/schema/blocklist.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { createLruCache } from '~/server/utils/lru-cache';
import { logToAxiom } from '~/server/logging/client';
import { buildBenignPhraseRegex, stripBenignPhrasesWith } from '~/shared/utils/benign-phrases';
import { removeTags, removeTagsCompact } from '~/utils/string-helpers';
import { foldConfusables } from '~/server/utils/confusable-fold';

export type BlocklistDTO = {
  id?: number;
  type: string;
  data: string[];
};

function getBlocklistKey(type: string) {
  return `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}` as RedisKeyTemplateCache;
}

// No in-process cache: pod-local copies can't be invalidated cross-pod on upsert.
async function setCache({ type, data }: { type: string; data: BlocklistDTO }) {
  await redis.set(getBlocklistKey(type), JSON.stringify(data), {
    EX: CacheTTL.month,
  });
}

/**
 * 🔴 DELETE, never a re-read written back. Writing a snapshot is itself a read-modify-write with no
 * lock over it, so two WRITERS the row lock correctly serialised could still land their cache writes
 * in the other order, leaving the LOSER's list under a month TTL. Deletes commute with each other,
 * so that ordering no longer decides anything.
 *
 * ⚠️ What this does NOT close: a DELETE does not commute with the POPULATE in `getBlocklistDTO`,
 * which is plain cache-aside. A reader that missed and read the row before the commit can `set` its
 * pre-write snapshot AFTER the bust, pinning it for the month TTL. A write guarantees the next read
 * misses, so a bust actively drives readers into that window. Closing it needs a lease, a version,
 * or a TTL short enough to bound the staleness; none of those is in this change.
 *
 * The moderator spoke busts the same key the same way. The two must agree.
 *
 * Never throws: the row is already committed by the time this runs, and the caller reporting
 * failure for a write that succeeded invites a retry of a write that already landed — the rule
 * `a04fa6a608` established for the session cache.
 */
async function bustCache(type: string) {
  try {
    await redis.del(getBlocklistKey(type));
  } catch (error) {
    logToAxiom({
      name: 'blocklist-cache-bust-failed',
      type: 'error',
      message: 'Blocklist row was written but its cache key was not cleared; readers stay stale',
      details: {
        blocklistType: type,
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
  }
}

/** An `id` that belongs to no row of the submitted `type`. Twin of the moderator spoke's. */
export class BlocklistRowMismatchError extends Error {
  constructor() {
    super('That blocklist row does not belong to this type.');
    this.name = 'BlocklistRowMismatchError';
  }
}

export async function upsertBlocklist({ id, type, blocklist }: UpsertBlocklistSchema) {
  const blocklistData = [
    ...new Set(blocklist.map((item) => item.toLowerCase()).filter((x) => x.length > 0)),
  ];

  // The read and the write share one transaction and the read takes a row lock. The merge is
  // read-modify-write over the whole array, so two overlapping edits each computed their merge
  // from the same pre-state and the later write restored what the earlier one dropped, both
  // reporting success. The other writer is the moderator spoke, editing the same column through
  // its own client — which is why the lock has to be in the database rather than in either app.
  const merged = await dbWrite.$transaction(
    async (tx) => {
      // Scoped to `type` always, and to `id` only when one was given — the same rule as the
      // spoke's `readRowForWrite`, and the two have to agree because they write one Redis key.
      // With no id it locks the rows of the type in id order and takes the FIRST, which is the row
      // `readBlocklistRow` enforces — so an add can never append to an EXISTING duplicate row
      // nobody reads. It does not stop one being created; see the create branch below.
      //
      // 🔴 `ORDER BY id ASC` and `locked[0]` are one decision, not two. Reading `locked.at(-1)`
      // here merges into the highest-id row while the SQL still says ASC, which is the
      // duplicate-row promotion this file exists to prevent, with the ordering still in the
      // statement to reassure whoever greps for it.
      //
      // Verified against dev Postgres 18 through Prisma 6.13 rather than assumed: a `text[]`
      // column comes back from `$queryRaw` as a real JS array, so the spread below merges
      // entries and not characters.
      const locked =
        id === undefined
          ? await tx.$queryRaw<{ id: number; data: string[] }[]>`
              SELECT id, data FROM "Blocklist" WHERE type = ${type} ORDER BY id ASC FOR UPDATE
            `
          : await tx.$queryRaw<{ id: number; data: string[] }[]>`
              SELECT id, data FROM "Blocklist" WHERE id = ${id} AND type = ${type} FOR UPDATE
            `;

      if (!locked.length) {
        // An `id` naming no row of this type is refused, never turned into an insert: a second row
        // for a type is the state `readBlocklistRow` exists to survive.
        //
        // ⚠️ The create below is NOT serialised. `FOR UPDATE` locks nothing when it matches
        // nothing, so two concurrent no-id upserts for a type with no row both reach it and the
        // type ends up with two. Unreachable from this app — the only caller always passes an id —
        // but the spoke's twin is reachable, and the closes are a unique index on `Blocklist.type`
        // or an advisory lock on the type, not this predicate.
        if (id !== undefined) return undefined;
        await tx.blocklist.create({ data: { data: blocklistData, type }, select: { id: true } });
        return blocklistData;
      }

      const next = [...new Set([...locked[0].data, ...blocklistData])];
      // `updateMany`, not `update`: it is the only Prisma UPDATE that takes a non-unique
      // `where`, and `type` has to be in it. The posted id and the posted type are independent
      // inputs, so without that predicate an id from another type merges these entries into that
      // row — benign phrases into a deny list, phishing patterns into the email-domain list.
      // (`@updatedAt` still applies here; measured, because `updateMany` skipping it would have
      // been invisible.)
      const { count } = await tx.blocklist.updateMany({
        where: { id: locked[0].id, type },
        data: { data: next },
      });
      // Unreachable while the locking read above holds: a row it returned is locked to commit,
      // so nothing can delete or re-type it underneath. Asserted anyway so the guarantee is
      // local — anyone who later moves either statement out of this transaction gets a failure
      // instead of a silent zero-row success that then caches a stale row for a month.
      if (count !== 1) throw new Error(`blocklist update matched ${count} rows under a row lock`);
      return next;
    },
    // Prisma's defaults are maxWait 2s / timeout 5s, and this path had no transaction before, so
    // both ceilings are new. The one caller is a weekly cron with no retry: a 2s wait for a
    // connection on a busy pool would cost a week's worth of disposable-domain additions.
    { maxWait: 10_000, timeout: 30_000 }
  );

  if (!merged) throw new BlocklistRowMismatchError();

  await bustCache(type);
}

/**
 * Nothing stops a type having more than one row. `EmailDomain` had two in production when this
 * was written — 8292 entries against 3, the 3 present nowhere else — and the old `findFirst` with
 * no `orderBy` let Postgres decide which set was enforced. (Re-checked 2026-08-24: every type now
 * has exactly one row, so the guard is currently inert. It is kept because nothing PREVENTS a
 * duplicate; see the first-insert race in `upsertBlocklist`.)
 *
 * No writer calls this any more. Its one caller is the cache-aside populate in `getBlocklistDTO` —
 * so this is what decides which row the whole system enforces, and a write busts the key, making
 * the next read a post-write read that pins a value for a month.
 *
 * This picks the lowest id, always, and reports the duplicate. It deliberately does NOT
 * union the rows: for a deny-list a union blocks more, but for the benign lists a union
 * strips more, which is a moderation bypass — one helper cannot silently pick a safe
 * direction for both. Nor does it throw: this read gates account signup, so a duplicate
 * row would become an outage. Deterministic-and-loud is the compromise until the rows are
 * merged and a unique index on `type` makes it unrepresentable.
 */
async function readBlocklistRow(type: BlocklistType): Promise<BlocklistDTO> {
  const rows = await dbWrite.blocklist.findMany({
    where: { type },
    select: { id: true, type: true, data: true },
    orderBy: { id: 'asc' },
  });

  if (rows.length > 1) {
    logToAxiom({
      name: 'blocklist-duplicate-rows',
      type: 'error',
      message:
        'More than one Blocklist row for a type; entries on the ignored rows are not enforced',
      details: {
        blocklistType: type,
        usedId: rows[0].id,
        ignoredIds: rows.slice(1).map((row) => row.id),
        ignoredEntryCounts: rows.slice(1).map((row) => row.data.length),
      },
    }).catch(() => undefined);
  }

  // The absent-row fallback deliberately carries NO `id`: `getClientBenignLists` reads that as
  // "no moderator row yet, use the bundled list". The moderator spoke writes the same shape into
  // the same Redis key, so this sentinel is a cross-app contract, not a local detail.
  return rows[0] ?? { type, data: [] };
}

export async function getBlocklistDTO({ type }: { type: BlocklistType }) {
  const cached = await redis.get(getBlocklistKey(type));
  if (cached) return JSON.parse(cached) as BlocklistDTO;

  const result = await readBlocklistRow(type);

  await setCache({ type: result.type, data: result });
  return result;
}

export async function getBlocklistData(type: BlocklistType) {
  return await getBlocklistDTO({ type }).then((blocklist) => blocklist.data);
}

// #region [blocked links]
/**
 * The scheme is OPTIONAL, which is the whole point of the leading group. `sanitizeHtml` stores a
 * scheme-relative `href` verbatim (it prepends `http://` only to compute the host it checks), so
 * `<a href="//evil.example/x">click</a>` survives to the database and the browser resolves it to
 * a live link — while a scheme-anchored regex sees no URL at all and the guard passes it.
 * A dotted host is still required after the slashes, so ordinary `//` in prose does not match.
 */
const LINK_PATTERN =
  /(?:(?:http|ftp|https):)?\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/gim;

/**
 * The spellings of a host that mean the same host to a browser but not to `===`.
 *
 * `url.host` carries the port, and a trailing dot is a legal absolute-root FQDN, so
 * `evil.example:8080` and `evil.example.` both resolve for the reader and both miss an entry of
 * `evil.example`. Comparing against every spelling can only match more, never less.
 *
 * Subdomains are deliberately NOT covered: matching `www.evil.example` against an entry of
 * `evil.example` is a moderation policy change (it would also block every subdomain of any host
 * on the list), not a normalisation fix.
 */
function hostSpellings(url: URL) {
  const withoutPort = url.hostname;
  return [url.host, withoutPort, withoutPort.replace(/\.$/, '')];
}

function findBlockedLinkDomains(value: string, blockedDomains: string[]) {
  const matches = value.toLowerCase().match(LINK_PATTERN);
  const blockedFor: string[] = [];
  if (matches) {
    for (const match of matches) {
      let url: URL;
      try {
        // A scheme-relative match has no scheme for `new URL()` to parse. Which scheme we
        // invent is irrelevant — only the host is read back.
        url = new URL(match.startsWith('//') ? `https:${match}` : match);
      } catch {
        // A regex-matched substring that `new URL()` can't parse isn't a URL we
        // can attribute to a host, so it can't be a blocked-domain hit. Skip it
        // (rather than block) — and, critically, never let a raw TypeError escape
        // as a 500 on user input. This IS reachable: e.g. `http://1.1.1.256/x`
        // matches the link regex but `new URL()` rejects the invalid IPv4 octet.
        continue;
      }
      const spellings = hostSpellings(url);
      if (blockedDomains.some((x) => spellings.includes(x))) blockedFor.push(match);
    }
  }
  return blockedFor;
}

export async function throwOnBlockedLinkDomain(value: string) {
  const blockedDomains = await getBlocklistData(BlocklistType.LinkDomain);
  const blockedFor = findBlockedLinkDomains(value, blockedDomains);

  // User-input validation rejection → BAD_REQUEST (400), not a plain Error (which
  // the tRPC layer would wrap as INTERNAL_SERVER_ERROR / 500).
  if (blockedFor.length) throwBadRequestError(`invalid urls: ${blockedFor.join(', ')}`);
}
// #endregion

// #region [benign phrases]
// In-process TTL cache over the Redis-backed blocklist: the scan path strips benign
// phrases on every image, so a short-lived local copy avoids a Redis round-trip per
// scan. TTL (not cross-pod invalidation) is the freshness bound — a moderator edit
// takes effect within `ttl` on every pod, which is fine for this non-urgent list.
const benignPhraseRegexCache = createLruCache<BlocklistType, { pattern: RegExp | null }>({
  name: 'benign-phrase-regex',
  ttl: CacheTTL.xs * 1000,
  keyFn: (type) => type,
  fetchFn: async (type) => ({ pattern: buildBenignPhraseRegex(await getBlocklistData(type)) }),
});

export { buildBenignPhraseRegex };

export async function stripBenignPhrases(text = '', type: BlocklistType) {
  if (!text) return text;
  const { pattern } = await benignPhraseRegexCache.fetch(type);
  if (!pattern) return text;
  // Same helper as the client gates on purpose — it carries the refusal that stops a
  // letter-bearing gap being swallowed, and the two sides must strip identically.
  return stripBenignPhrasesWith(text, pattern);
}
/**
 * The benign lists the BROWSER needs. The search gates (`AutocompleteSearch`,
 * `SearchLayout`) run their POI / minor / profanity checks client-side against Meili
 * directly, so there is no server hop to strip on — the lists have to be shipped down.
 * Public and edge-cached; these are phrases moderators have declared SAFE, so the list
 * says nothing about what we block.
 */
export type ClientBenignLists = {
  prompt: string[];
  /** `null` means "no moderator row", which is NOT the same as an empty one — see the filter. */
  profanityWords: string[] | null;
  /** False when the lists could not be read. The caller MUST NOT let the edge cache this. */
  available: boolean;
};

export async function getClientBenignLists(): Promise<ClientBenignLists> {
  try {
    const [prompt, profanityRow] = await Promise.all([
      getBlocklistData(BlocklistType.PromptBenignPhrase),
      getBlocklistDTO({ type: BlocklistType.ProfanityBenignWord }),
    ]);
    // A row that EXISTS but is empty is a moderator having deleted every entry — the
    // strongest possible "do not whitelist" intent. Only a MISSING row means "not migrated",
    // which is the case that falls back to the list shipped in the bundle.
    const profanityWords = profanityRow.id == null ? null : profanityRow.data;
    return { prompt, profanityWords, available: true };
  } catch (error) {
    // Fails OPEN, and empty is the safe direction: nothing is stripped, so the gates flag
    // more rather than less. `available: false` exists because the caller must then skip the
    // edge cache — a 200 carrying empty lists would otherwise be held for an hour, and every
    // session started in that window pins it for its whole life, reinstating globally the
    // false positives this work removes. The throw it replaced was never cached.
    logToAxiom({
      name: 'benign-lists-unavailable',
      type: 'warning',
      message: 'Serving empty benign lists to the client; search gates will not strip',
      details: { error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
    return { prompt: [], profanityWords: null, available: false };
  }
}
// #endregion

// #region [blocked message patterns]
/**
 * Returns the matched pattern, or `undefined`. Callers must test against `undefined` and NOT
 * for truthiness: an empty pattern matches every string and returns `''`, so a truthiness test
 * silently swallows exactly the case `substringEntries` exists to prevent — and swallowing it
 * looks like the guard working.
 */
function findBlockedPattern(value: string, blockedPatterns: string[]) {
  const lowerValue = value.toLowerCase();
  return blockedPatterns.find((pattern) => lowerValue.includes(pattern));
}

/**
 * Entries for a SUBSTRING match. Empties dropped, and deliberately NOT folded.
 *
 * 🔴 Folding a substring rule rewrites what the rule means. Measured against the 90 live
 * `MessagePattern` rows: 17 of the 19 non-ASCII ones fold to a string nobody added, and two of
 * them fold to a single ordinary English word. Their live ASCII neighbours are all narrow
 * multi-word phrases containing that word, so a moderator adding a stylised-only row was
 * drawing exactly that distinction. Folding erases it, and `includes` then rejects every
 * comment carrying the bare word — 44 of 94,376 comments and 42 of 87,113 DMs over 30 days on
 * production. (The rows are not quoted here: this repo is public, and a term list tells a
 * reader what is blocked while a stated absence tells them what is not.)
 *
 * Folding the CONTENT is still done, and is the half that stops the bypass: homoglyph text
 * reaches an ASCII rule that way. The other consequence, stated because it is not obvious: a
 * folded form is always ASCII, so a non-ASCII entry can only ever be found in the RAW form,
 * byte for byte. 19 of the 90 live rows are in that position. That is not a regression — they
 * were equally narrow on DMs before this — but it is the reason the answer is to normalise at
 * WRITE time in the moderator UI, where broadening a rule can be a visible deliberate act. The cost of not folding entries is narrower and it is the safe
 * direction — a stylised-only row no longer catches the plain-ASCII spelling, which a moderator
 * can add as a row, whereas nobody can undo a rule that silently ate a common word.
 *
 * 🔴 The empty filter is not defensive tidying either. `includes('')` is true for every string,
 * so one empty entry blocks every comment on the site.
 */
function substringEntries(entries: string[]) {
  return entries.filter((entry) => entry.trim().length > 0);
}

/**
 * Entries for an EXACT match — link domains, compared with `===` against `url.host`.
 *
 * These ARE folded, and safely enough: an exact-match rule cannot broaden WITHIN a namespace,
 * because a folded host is just one more host that has to be equalled in full. Note the
 * qualifier — folding crosses namespaces, so a lookalike entry manufactures the REAL domain as
 * a live rule. Checked against the 6 non-ASCII rows live today: every one folds to its intended
 * target and none is a mainstream domain. Adding a lookalike of a domain we do not want to
 * block would block it here and nowhere else, since `throwOnBlockedLinkDomain` does not fold. That is the whole difference from
 * `substringEntries` above, and it is why the two exist separately rather than as one helper
 * with a flag. 6 of the 696 live link domains are non-ASCII — styled Unicode and
 * invisible-character spellings — and folding them is what makes those rows enforce at all.
 */
function exactEntries(entries: string[]) {
  return [...new Set([...entries, ...entries.map(foldConfusables)])].filter(
    (entry) => entry.trim().length > 0
  );
}

export async function throwOnBlockedMessagePattern(value: string) {
  const blockedPatterns = await getBlocklistData(BlocklistType.MessagePattern);
  if (!blockedPatterns.length) return;

  const matchable = substringEntries(blockedPatterns);
  const matched =
    findBlockedPattern(value, matchable) ?? findBlockedPattern(foldConfusables(value), matchable);
  // BAD_REQUEST, not a bare `Error`: this is a rejection of user input, and a plain throw
  // reaches the client as a 500 that tells the sender nothing.
  if (matched !== undefined) throwBadRequestError('Message blocked by content filter');
}
// #endregion

// #region [comment content]
/**
 * The forms of a comment a pattern could be hiding in. Comments are stored as HTML, and
 * scanning any single form has a measured hole in it:
 *
 * - the raw string misses a pattern split by a tag. `phish-verify<strong>5</strong>92807.example`
 *   is the shape the editor stores, and `strong`/`em`/`u`/`s`/`span`/`code`/`a` all survive
 *   `COMMENT_ALLOWED_TAGS`. A sticker `<span>` splits a pattern the same way.
 * - the tag-stripped text misses anything that only exists in an attribute. Drop the tag from
 *   `<a href="https://evil.example/x">click</a>` and the URL is gone; what is left is "click".
 * - `removeTags` (tag to a space, then collapse) does not close the first hole — `id 592807`
 *   still fails to match. Joining with nothing does not close the third: it glues
 *   `<p>a</p><p>b</p>` into `ab`, so a multi-word pattern that needs the space stops matching.
 *
 * Hence every form, not a chosen one. Scanning an extra form can only make the filter match
 * more, never less, so a form added later cannot open a bypass.
 *
 * 🔴 Keeping the RAW form is load-bearing beyond the `href` case. Because it is scanned, every
 * literal substring of the stored string is always visible to the matcher, whatever malformed
 * markup does to the derived forms — an attribute value containing `>` desynchronises the tag
 * regex, and the raw form is what still carries the URL. Drop it as redundant (the other two
 * look like supersets, and are not) and that guarantee goes with it.
 *
 * The collapse in `removeTags` is load-bearing, not tidiness: `</p><p>` becomes TWO spaces, and
 * a pattern carrying one space then misses the very case this form exists for.
 */
export function scannableCommentForms(content: string) {
  const forms = [content, removeTagsCompact(content), removeTags(content)];
  return [...new Set([...forms, ...forms.map(foldConfusables)])];
}

/**
 * Both blocklists over a comment. Comments never called the pattern list at all until now,
 * which is how 366 accounts posted phishing comments in four hours on 2026-08-24 while the
 * same patterns were being enforced on DMs.
 *
 * Moderators are exempt from BOTH lists. Several of these patterns ARE the phishing text, and
 * quoting it to warn people is a thing moderators do — one such comment is live on the site
 * today. The link half was raised explicitly (it was NOT exempt on `main`) and kept exempt on
 * purpose, 2026-08-24; do not restore it without asking.
 *
 * The DM precedent is not uniform and should not be cited as though it were: chat SEND exempts
 * moderators from both lists, chat EDIT exempts nobody.
 */
export async function throwOnBlockedCommentContent(
  content: string,
  { isModerator = false }: { isModerator?: boolean } = {}
) {
  if (isModerator) return;

  const [blockedDomains, blockedPatterns] = await Promise.all([
    getBlocklistData(BlocklistType.LinkDomain),
    getBlocklistData(BlocklistType.MessagePattern),
  ]);
  const matchable = substringEntries(blockedPatterns);
  const matchableDomains = exactEntries(blockedDomains);

  for (const form of scannableCommentForms(content)) {
    const blockedFor = findBlockedLinkDomains(form, matchableDomains);
    if (blockedFor.length) throwBadRequestError(`invalid urls: ${blockedFor.join(', ')}`);

    if (findBlockedPattern(form, matchable) !== undefined)
      throwBadRequestError('Comment blocked by content filter');
  }
}
// #endregion

// #region [blocked emails]
export async function getBlockedEmailDomains() {
  return await getBlocklistData(BlocklistType.EmailDomain);
}
// #endregion
