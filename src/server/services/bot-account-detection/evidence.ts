import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import type { BotAccountCohortMember } from './cohort';

/**
 * The COHORT-LEVEL evidence: the things that are only visible by looking at the whole day's signups
 * at once, rather than at one account.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL. Two of the three heuristics are ring detectors — "how many OTHER
 * new accounts registered on this IP", "how many OTHER new accounts posted this text" — and a
 * per-account scoring function cannot answer either. Scoring one account at a time is exactly what
 * misses a coordinated wave, which is the case the operator named as the reason for the clustering
 * heuristic. So the cohort is indexed ONCE per run, and each heuristic reads its member's entry out
 * of a precomputed index rather than issuing a query of its own.
 *
 * That split is also what keeps the heuristics testable: every scoring function in `heuristics/` is
 * pure over `CohortSignals`, and the only IO lives here.
 *
 * 🔴 THIS MODULE READS, AND THAT IS ALL IT CAN DO. Its Postgres surface is the two-method structural
 * port `EvidenceDb` below — two `findMany` calls, no write method — and its ClickHouse surface is a
 * single `$query`. Both are asserted as ledgers in `__tests__/no-write-surface.test.ts`, which also
 * pins that every ClickHouse statement in this module is a bare `SELECT`. The operation ledger there
 * anchors on a `db` handle and therefore CANNOT see a ClickHouse call at all — that is precisely why
 * the ClickHouse ledger is a separate assertion rather than an assumed extension of the first.
 */

/**
 * The most content rows one run will read, across every account and both comment surfaces.
 *
 * 🔴 A BUDGET, NOT A PER-QUERY LIMIT, and the distinction is the whole point. The cohort is bounded
 * only by `MAX_COHORT_ACCOUNTS`, and a wave day is exactly when it approaches that; a per-query cap
 * multiplied by a page count is not a bound on anything. This is decremented as chunks are read and
 * the walk stops when it is gone, so the worst case is fixed no matter how large the cohort gets.
 *
 * The cohort arrives NEWEST FIRST (see `cohort.ts`), so a budget that runs out spends itself on the
 * most recent signups and abandons the oldest — the same direction the account walk truncates in,
 * for the same reason. `content_budget_exhausted` says when that happened; without it a partially
 * sampled run is indistinguishable from a cohort that simply posted less.
 */
export const MAX_CONTENT_SAMPLES = 5_000;

/** How many accounts' ids go into one `IN (…)` list. Matches the cohort's own page size so the two
 *  walks put the same width of list in front of the planner. */
export const EVIDENCE_CHUNK_SIZE = 500;

/**
 * How much of one comment is kept.
 *
 * Templated shill text is identical from its first words; the tail is padding. Truncating on receipt
 * bounds the memory a run holds to `MAX_CONTENT_SAMPLES × this` regardless of how long a single
 * comment is, and it bounds the fingerprint keys the index is built out of.
 *
 * 🔴 IT IS APPLIED BEFORE NORMALISATION, so two texts that differ only past this point fingerprint
 * IDENTICALLY. That is a deliberate widening of what counts as "the same text" and it is stated
 * because it can produce a false cluster: a long shared quotation with different endings collides.
 * The alternative — truncating after normalisation — has the same property one step later.
 */
export const MAX_CONTENT_CHARS = 512;

/** One account's registration, as ClickHouse recorded it. */
export type RegistrationIpRow = { userId: number; ip: string };

/** One piece of text an account posted. */
export type ContentSampleRow = { userId: number; content: string };

/**
 * The Postgres slice this module is allowed to use: two reads, no write method, nothing to widen.
 *
 * Written structurally rather than as `typeof dbRead` for the reason `cohort.ts` gives at length —
 * naming the read handle buys convention, not reachability, because `dbRead` and `dbWrite` are the
 * same object wherever the replica URL equals the primary's. A type with no write method on it is
 * what actually holds the property.
 */
export type EvidenceDb = {
  comment: {
    findMany: (args: ReturnType<typeof contentSampleArgs>) => Promise<ContentSampleRow[]>;
  };
  commentV2: {
    findMany: (args: ReturnType<typeof contentSampleArgs>) => Promise<ContentSampleRow[]>;
  };
};

/**
 * The ClickHouse slice: one method, which takes SQL and returns rows.
 *
 * 🔴 IT IS OPTIONAL BECAUSE THE REAL CLIENT IS. `~/server/clickhouse/client` exports
 * `clickhouse: CustomClickHouseClient | undefined` — it is `undefined` whenever `CLICKHOUSE_HOST` or
 * `CLICKHOUSE_USERNAME` is unset, and during a Next build. A detector that assumed it existed would
 * throw on those deployments; one that caught the error and moved on would report a clean run with a
 * silently dead heuristic, which is worse. So absence is a FIRST-CLASS STATE carried on
 * `CohortSignals.sources` and reported as a counter — see `collectCohortSignals`.
 */
/**
 * 🔴 THE `T extends object` CONSTRAINT MIRRORS THE REAL CLIENT AND IS NOT DECORATION. The shipped
 * `$query` is `<T extends object>(query: TemplateStringsArray | string, …values) => Promise<T[]>`;
 * a port declaring plain `<T>` is a DIFFERENT generic signature, so the real client is not assignable
 * to it and the union of the two is not callable at all. Narrowing the parameter to `string` is safe
 * in the other direction — a function accepting more shapes is assignable to one accepting fewer —
 * and it removes the tagged-template form this module deliberately does not use.
 */
export type EvidenceClickhouse = { $query: <T extends object>(sql: string) => Promise<T[]> };

export type EvidenceReader = {
  /** Registration IPs for exactly these accounts. Empty when ClickHouse is unavailable. */
  listRegistrationIps(userIds: number[]): Promise<RegistrationIpRow[]>;
  /** Up to `take` recent comments across both comment surfaces, for exactly these accounts. */
  listContentSamples(userIds: number[], take: number): Promise<ContentSampleRow[]>;
  /** Whether a registration-IP read can happen at all. `false` means the source is missing, NOT
   *  that the accounts share no IP. */
  hasRegistrationIps: boolean;
};

/**
 * The `findMany` arguments for one chunk of accounts' comments.
 *
 * Exported and built apart from the call for the reason `newAccountPageArgs` is: this is the part
 * with behaviour, and asserting it is how "reads the right columns, newest first, bounded" becomes
 * testable without a database.
 *
 * 🔴 `orderBy: { id: 'desc' }` is load-bearing, not decoration. The `take` bounds a chunk, so the
 * order decides WHICH comments a bounded read keeps — and the newest are the ones a wave is made of.
 * Ascending would spend the budget on whatever the chunk's accounts happened to post first.
 *
 * Only `userId` and `content` are selected. Nothing else is needed to fingerprint text, and a
 * comment's `id`, thread and timestamps would only widen what this module holds in memory.
 */
export function contentSampleArgs(userIds: number[], take: number) {
  return {
    where: { userId: { in: userIds } },
    select: { userId: true, content: true },
    orderBy: { id: 'desc' },
    take,
  } as const;
}

/**
 * The registration-IP query.
 *
 * Built as a separate exported function so the SQL is a value a test can assert on, rather than a
 * string buried in a call — the ClickHouse ledger in `__tests__/no-write-surface.test.ts` reads it
 * and pins that it is a bare `SELECT`.
 *
 * 🔴 `targetUserId`, NOT `userId`, AND THE TWO ARE NOT INTERCHANGEABLE. `Tracker.userActivity` writes
 * the account the event is ABOUT into `targetUserId`; a `Registration` event has no signed-in actor,
 * so the `userId` provenance column is not the new account. `apps/moderator/src/lib/server/bulk-ban.service.ts`
 * — the ban-evasion queries this heuristic is adapted from — reads `targetUserId` for exactly this
 * reason. (`csam.service.ts` filters the same table on `userId`; that is a different question about
 * a signed-in user's own activity, and copying its predicate here would silently return nothing.)
 *
 * 🔴 IDS ARE RE-VALIDATED AS INTEGERS AT THE JOIN, not trusted for having come from the database.
 * This is string-interpolated SQL — the ClickHouse client takes no bound parameters here — so the
 * only thing standing between a value and the statement is this filter. It is cheap and it is the
 * kind of guard that is correct until someone routes a different id source into it.
 *
 * `GROUP BY` rather than a plain select: an account can have several registration rows, and the
 * heuristic wants distinct (account, ip) pairs, not a row count. `LIMIT` bounds a pathological
 * chunk — an account with thousands of recorded registration events cannot flood the result.
 */
export function registrationIpSql(userIds: number[]): string {
  const ids = userIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return '';
  return `
    SELECT targetUserId, ip
    FROM default.userActivities
    WHERE targetUserId IN (${ids.join(',')})
      AND type = 'Registration'
    GROUP BY targetUserId, ip
    LIMIT ${ids.length * 4}
  `;
}

/** The real reader: Postgres over the replica, ClickHouse where it exists. */
export function createEvidenceReader(
  deps: { db?: EvidenceDb; ch?: EvidenceClickhouse | null } = {}
): EvidenceReader {
  const db = deps.db ?? dbRead;
  // `deps.ch` may be explicitly `null` to model an unavailable client in a test; `undefined` falls
  // back to the real one, which is itself possibly `undefined`.
  // Annotated rather than inferred: without it the ternary widens to a UNION of the port and the
  // real client's own type, and a union of two generic call signatures is not callable — the error
  // lands on the `$query` call below and names it "not callable", which reads as a defect in the
  // client rather than in this line.
  const ch: EvidenceClickhouse | null = deps.ch === undefined ? clickhouse ?? null : deps.ch;

  return {
    hasRegistrationIps: ch !== null,
    listRegistrationIps: async (userIds) => {
      const sql = registrationIpSql(userIds);
      if (!ch || !sql) return [];
      const rows = await ch.$query<{ targetUserId: string | number; ip: string }>(sql);
      // ClickHouse returns integers as strings over HTTP JSON; `Number` on an already-numeric value
      // is a no-op, so this covers both without asking which one arrived.
      return rows
        .map((r) => ({ userId: Number(r.targetUserId), ip: r.ip }))
        .filter((r) => Number.isFinite(r.userId) && !!r.ip);
    },
    listContentSamples: async (userIds, take) => {
      if (!userIds.length || take <= 0) return [];
      const [comments, commentsV2] = await Promise.all([
        db.comment.findMany(contentSampleArgs(userIds, take)),
        db.commentV2.findMany(contentSampleArgs(userIds, take)),
      ]);
      return [...comments, ...commentsV2];
    },
  };
}

/**
 * Text reduced to the shape a templating check compares.
 *
 * 🔴 THE MASKING IS THE DETECTION. An exact-match check over raw text finds only literal copy-paste,
 * and a shill ring's whole method is one template with the payload swapped — the link, the referral
 * code, the amount. Replacing links and digit runs with placeholders BEFORE comparing is what turns
 * "check out mysite.example/a" and "check out mysite.example/b" into one fingerprint, and it is the
 * only part of this heuristic that is not simply string equality.
 *
 * 🔴 IT IS ALSO WHERE THE FALSE POSITIVES COME FROM, and pretending otherwise would be the
 * comfortable lie. Masking numbers means "I got 5 buzz" and "I got 900 buzz" collide, which is
 * correct for a payout ring and wrong for two people saying an ordinary thing. `MIN_FINGERPRINT_CHARS`
 * and `MIN_FINGERPRINT_TOKENS` below are the whole defence against that, they are set by judgement
 * rather than by measurement, and the shadow phase exists to replace that judgement with a number.
 *
 * Order matters: links are masked first, because a URL contains the punctuation and digits the later
 * steps would otherwise chew through and turn into an unrecognisable token. The placeholders are
 * bare words rather than bracketed markers so the punctuation strip cannot destroy them.
 */
export function normalizeContent(raw: string): string {
  return (
    raw
      .slice(0, MAX_CONTENT_CHARS)
      .toLowerCase()
      .replace(/https?:\/\/\S+|www\.\S+/g, ' linkmask ')
      .replace(/\d+/g, ' nummask ')
      // Everything that is not a letter, a digit or a space. Emoji, punctuation and the zero-width
      // characters spam text is padded with all go, so a template survives being decorated.
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The shortest normalised text that may act as a cluster key.
 *
 * 🔴 A SHORT STRING IS NOT EVIDENCE OF ANYTHING. "thanks", "nice work", "great model" are written
 * independently by unrelated people every hour, and without a floor they would cluster a day's
 * politest new accounts into a fake ring — the single most likely way this heuristic fires on the
 * innocent. Both a character floor and a token floor, because either alone is walkable: one long
 * word clears the character floor, and four one-letter words clear the token floor.
 */
export const MIN_FINGERPRINT_CHARS = 24;
export const MIN_FINGERPRINT_TOKENS = 4;

/**
 * The cluster key for one piece of text, or `null` when the text is too slight to be one.
 *
 * Returning `null` rather than a key is the honest encoding: the alternative — a key that simply
 * matches rarely — still clusters whenever it does match, and the whole point is that these texts
 * must never cluster at all.
 */
export function contentFingerprint(raw: string): string | null {
  const normalized = normalizeContent(raw);
  if (normalized.length < MIN_FINGERPRINT_CHARS) return null;
  if (normalized.split(' ').filter(Boolean).length < MIN_FINGERPRINT_TOKENS) return null;
  return normalized;
}

/**
 * Everything the cohort-level heuristics read, indexed once per run.
 *
 * 🔴 EVERY COUNT HERE IS A COUNT OF DISTINCT ACCOUNTS, never of rows. One account pasting the same
 * text ninety times is one member of that fingerprint's set, not ninety — otherwise a single
 * prolific spammer manufactures a ring out of itself and every other heuristic's independence is
 * lost. The same holds for IPs and domains. The sets are built with `Set`s for that reason and the
 * public shape exposes sizes rather than lists.
 */
export type CohortSignals = {
  /** userId → the registration IPs recorded for it. Absent means no row, or no ClickHouse. */
  ipsByUser: Map<number, string[]>;
  /** ip → how many DISTINCT cohort members registered on it. */
  membersPerIp: Map<string, number>;
  /** emailDomain → how many DISTINCT cohort members carry it. */
  membersPerDomain: Map<string, number>;
  /** userId → the content fingerprints it produced. */
  fingerprintsByUser: Map<number, string[]>;
  /** fingerprint → how many DISTINCT cohort members produced it. */
  membersPerFingerprint: Map<string, number>;
  /**
   * 🔴 WHICH SOURCES ACTUALLY ANSWERED. A heuristic reading an empty index cannot tell "these
   * accounts share nothing" from "nobody asked" — and the two call for opposite conclusions. Every
   * consumer of this type is expected to branch on these before reading a zero as a signal.
   */
  sources: {
    /** ClickHouse was reachable and the registration-IP read ran. */
    registrationIps: boolean;
    /** The content budget was spent before the whole cohort was sampled. */
    contentBudgetExhausted: boolean;
    /** How many members had content sampled at all. The denominator for the similarity heuristic. */
    membersSampledForContent: number;
  };
};

/** An index over nothing: the shape every map has before a run, and what a zero-member cohort
 *  yields. Sources default to "did not run", which is the safe reading. */
export function emptyCohortSignals(): CohortSignals {
  return {
    ipsByUser: new Map(),
    membersPerIp: new Map(),
    membersPerDomain: new Map(),
    fingerprintsByUser: new Map(),
    membersPerFingerprint: new Map(),
    sources: {
      registrationIps: false,
      contentBudgetExhausted: false,
      membersSampledForContent: 0,
    },
  };
}

/** Fixed-size slices of an id list, in order. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fold the raw reads into the indexes, PURELY.
 *
 * Separated from the IO above because this is the half with the arithmetic in it — the distinct-account
 * counting, the fingerprinting, the domain tally — and it is the half worth testing exhaustively.
 * `collectCohortSignals` is then a loop that fetches and calls this.
 *
 * 🔴 THE DOMAIN TALLY IS BUILT FROM THE MEMBERS, NOT FROM A QUERY. `emailDomain` already rode in on
 * every cohort member, so the domain half of the clustering heuristic costs ZERO additional reads.
 * That is worth saying plainly: of the two signals in that heuristic, one is free and one needs
 * ClickHouse, so the heuristic keeps working — at reduced power, and it says so — when ClickHouse
 * does not.
 */
export function buildCohortSignals(args: {
  members: BotAccountCohortMember[];
  registrationIps: RegistrationIpRow[];
  contentSamples: ContentSampleRow[];
  sources: CohortSignals['sources'];
}): CohortSignals {
  const signals = emptyCohortSignals();
  signals.sources = args.sources;

  // Only accounts that are actually IN the cohort may contribute to a cluster count. A registration
  // row for an id outside it — a banned account ClickHouse still remembers, a stale row — would
  // otherwise inflate an IP's tally without ever being scored.
  const inCohort = new Set(args.members.map((m) => m.userId));

  const ipMembers = new Map<string, Set<number>>();
  for (const row of args.registrationIps) {
    if (!inCohort.has(row.userId)) continue;
    const ips = signals.ipsByUser.get(row.userId);
    if (ips) {
      if (!ips.includes(row.ip)) ips.push(row.ip);
    } else signals.ipsByUser.set(row.userId, [row.ip]);
    let members = ipMembers.get(row.ip);
    if (!members) ipMembers.set(row.ip, (members = new Set()));
    members.add(row.userId);
  }
  for (const [ip, members] of ipMembers) signals.membersPerIp.set(ip, members.size);

  const domainMembers = new Map<string, Set<number>>();
  for (const member of args.members) {
    if (!member.emailDomain) continue;
    let members = domainMembers.get(member.emailDomain);
    if (!members) domainMembers.set(member.emailDomain, (members = new Set()));
    members.add(member.userId);
  }
  for (const [domain, members] of domainMembers) signals.membersPerDomain.set(domain, members.size);

  const fingerprintMembers = new Map<string, Set<number>>();
  for (const sample of args.contentSamples) {
    if (!inCohort.has(sample.userId)) continue;
    const fingerprint = contentFingerprint(sample.content);
    if (!fingerprint) continue;
    const owned = signals.fingerprintsByUser.get(sample.userId);
    if (owned) {
      if (!owned.includes(fingerprint)) owned.push(fingerprint);
    } else signals.fingerprintsByUser.set(sample.userId, [fingerprint]);
    let members = fingerprintMembers.get(fingerprint);
    if (!members) fingerprintMembers.set(fingerprint, (members = new Set()));
    members.add(sample.userId);
  }
  for (const [fingerprint, members] of fingerprintMembers)
    signals.membersPerFingerprint.set(fingerprint, members.size);

  return signals;
}

/**
 * Read every cohort-level source and index the result.
 *
 * 🔴 A FAILING SOURCE DEGRADES THE RUN, IT DOES NOT FAIL IT — and it is recorded, which is the half
 * that matters. A ClickHouse outage must not lose a day of the cheap heuristics; it must also never
 * look like a day on which no accounts shared an IP. So the read is guarded, the flag on
 * `sources.registrationIps` carries the outcome, and `run.ts` turns it into a counter that a grading
 * pass can filter on. A run whose IP data was missing is not comparable with one whose was there,
 * and this flag is the only thing that says which kind you are looking at.
 *
 * The content walk is a BUDGET, not a per-chunk cap — see `MAX_CONTENT_SAMPLES`.
 */
export async function collectCohortSignals(
  reader: EvidenceReader,
  members: BotAccountCohortMember[],
  opts: {
    chunkSize?: number;
    maxContentSamples?: number;
    checkCanceled?: () => void;
    log?: (name: string, data: Record<string, unknown>) => void;
  } = {}
): Promise<CohortSignals> {
  const chunkSize = opts.chunkSize ?? EVIDENCE_CHUNK_SIZE;
  const budgetTotal = opts.maxContentSamples ?? MAX_CONTENT_SAMPLES;
  const checkCanceled = opts.checkCanceled ?? (() => undefined);
  const log = opts.log ?? (() => undefined);

  if (!members.length) return emptyCohortSignals();

  const chunks = chunk(
    members.map((m) => m.userId),
    chunkSize
  );

  const registrationIps: RegistrationIpRow[] = [];
  let ipsRead = reader.hasRegistrationIps;
  if (ipsRead) {
    for (const ids of chunks) {
      checkCanceled();
      try {
        registrationIps.push(...(await reader.listRegistrationIps(ids)));
      } catch (e) {
        // One failed chunk invalidates the IP signal for the WHOLE run, not just for its own
        // accounts: a cluster count built from a partial read UNDERSTATES every ring that straddles
        // the missing chunk, and understating is the direction that produces a confident zero. So
        // the partial data is discarded rather than scored.
        log('bot-account-detection:registration-ips-failed', {
          chunkIds: ids.length,
          error: e instanceof Error ? e.message : String(e),
        });
        registrationIps.length = 0;
        ipsRead = false;
        break;
      }
    }
  }

  const contentSamples: ContentSampleRow[] = [];
  let budget = budgetTotal;
  let budgetExhausted = false;
  let membersSampled = 0;
  for (const ids of chunks) {
    checkCanceled();
    if (budget <= 0) {
      budgetExhausted = true;
      break;
    }
    // The per-surface `take` is the remaining budget, so one chunk can never consume more than what
    // is left; `listContentSamples` reads two surfaces, so the actual return can be up to twice it.
    // Bounding the SPEND rather than the take is what keeps the total fixed.
    const rows = await reader.listContentSamples(ids, Math.min(budget, chunkSize * 2));
    membersSampled += ids.length;
    budget -= rows.length;
    contentSamples.push(...rows);
  }
  if (budget <= 0 && membersSampled < members.length) budgetExhausted = true;

  return buildCohortSignals({
    members,
    registrationIps,
    contentSamples,
    sources: {
      registrationIps: ipsRead,
      contentBudgetExhausted: budgetExhausted,
      membersSampledForContent: Math.min(membersSampled, members.length),
    },
  });
}
