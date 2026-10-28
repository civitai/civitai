import { z } from 'zod';
import type { TurnSource } from '$lib/assistant/types';
import type { PermissionId } from '$lib/permissions';
import { imageLookupUrl, userLookupUrl, userReportUrl } from '$lib/entity-url';
import { DEFAULT_REPORT_STATUSES } from '$lib/reports';
import { getDossier } from '../dossier.service';
import {
  DEFAULT_REACTION_DAYS,
  MAX_REACTION_DAYS,
  getAccountsOnAddresses,
  getLinkedAccounts,
  getReactionBreadth,
  getSetLinks,
  maskLinkedAddresses,
  type LinkedAccounts,
} from '../ip-links.service';
import {
  getInflationActors,
  getSharedIpCoverage,
  isClickhouseTimeout,
  type SharedIpAccount,
} from '../reactor-lookup.service';
import { getBuzzFlows, MAX_BUZZ_DAYS } from '../buzz-flows.service';
import { getPlacementFlows } from '../placement-flows.service';
import {
  getReportsOnUser,
  getReportsReceived,
  getReportsSubmitted,
  type UserReportRow,
} from '../user-reports.service';
import { getAbuseFindingsForUser } from '../abuse-detection.service';
import { resolveUserId } from '../user-lookup.service';
import { MAX_INT4 } from '../users.service';
import { redactAddresses } from '../redact-addresses';
import {
  type AccountRow,
  getAccounts,
  getOpenUserReports,
  HUMAN_REPORT_REASONS,
  MAX_ACCOUNTS,
  searchAccounts,
} from './reads';
import { getRegistrationEmails, normalizeEmail, redactEmails } from './email';
import { addPlaybookVersion, fileToolRequest, getPlaybook, listPlaybooks } from './store';

// The assistant's tools. Every one but the last two is a READ: no tool bans, mutes, strikes, removes,
// rules on a report or messages anyone. The two writes touch only the assistant's own tables.
//
// A moderator is offered only the tools whose `requires` pages they hold, so the assistant is never a
// way round a page grant. Addresses are shown only to a moderator who could read them in User Lookup.

export type ToolContext = {
  moderatorId: number;
  chatId: number;
  turnId: number;
  canAccess: (path: string) => boolean;
  hasGrant: (permission: PermissionId) => boolean;
  /** An address's label for a moderator who cannot read addresses: the same label all chat long, so a
   *  later turn's "address 3" is the earlier turn's. */
  mask: (cluster: string) => string;
  /** The moderator's prompts and the assistant's answers so far, for a tool request's record. */
  conversation: () => { prompt: string; answer: string | null }[];
};

export type ToolResult = {
  data: unknown;
  /** Records returned, for the audit. */
  rows: number;
  truncated: boolean;
  sources: TurnSource[];
};

type Tool<S extends z.ZodType> = {
  name: string;
  description: string;
  input: S;
  /** Any one of these pages opens the data. `null`: every assistant user. */
  requires: string[] | null;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolResult>;
  timeoutMs?: number;
  onTimeout?: (args: z.output<S>) => Record<string, unknown>;
};

const tool = <S extends z.ZodType>(t: Tool<S>) => t;

export const LOOKUP = '/retool/user-lookup';
const USER_REPORTS = '/reports/user';
const REACTOR_LOOKUP = '/retool/reactor-lookup';

const showAddresses = (ctx: ToolContext) => ctx.canAccess(LOOKUP);
/** Free text (a playbook) as this moderator may read it. */
const shownText = (ctx: ToolContext, text: string) =>
  showAddresses(ctx) ? text : redactAddresses(text);
const shownAddress = (ctx: ToolContext) => (cluster: string) =>
  showAddresses(ctx) ? cluster : ctx.mask(cluster);

const showEmails = (ctx: ToolContext) => showAddresses(ctx) && ctx.hasGrant('assistant.emails');
/** Each account's registration email and the inbox it delivers to; nothing when this moderator may not
 *  see them. */
async function emailFields(ctx: ToolContext, userIds: number[]) {
  const emails = showEmails(ctx) && userIds.length ? await getRegistrationEmails(userIds) : null;
  return (userId: number) => {
    if (!emails) return {};
    const email = emails.get(userId) ?? null;
    return { email, normalizedEmail: email && normalizeEmail(email) };
  };
}
async function withEmails<T extends { userId: number }>(ctx: ToolContext, rows: T[]) {
  const fields = await emailFields(
    ctx,
    rows.map((r) => r.userId)
  );
  return rows.map((r) => ({ ...r, ...fields(r.userId) }));
}
const ACCOUNT_FIELDS = [
  'username',
  'createdAt',
  'bannedAt',
  'banReason',
  'deletedAt',
  'muted',
  'strikes',
  'email',
  'normalizedEmail',
] as const satisfies readonly (Exclude<keyof AccountRow, 'userId'> | 'email' | 'normalizedEmail')[];

/** Addresses per accounts_on_address call: the most measured on prod (25 took 13.8 s on 2026-10-26,
 *  flat from 1 address up), within half of `ACCOUNTS_ON_ADDRESS_TIMEOUT_MS`. Past 50, raise
 *  `groupUniqArray(50)` in ip-links.service.ts too, or an account's address list is cut short. */
const MAX_BATCH_ADDRESSES = 25;
/** Each call scans the reaction and login tables by address: 10-45 s on prod, so the default is short. */
const ACCOUNTS_ON_ADDRESS_TIMEOUT_MS = 90_000;

const EMAILS_NOTE =
  'With the registration-email grant each account also carries `email` and `normalizedEmail` (Gmail dots and +tags removed, lower-cased). Several accounts on one normalizedEmail are one inbox; many accounts on one rare or throwaway domain, or rotating through a few such domains, is a mass-registration tell. Quote an email only as evidence; playbooks and tool requests drop them.';

const userSource = (id: number, username: string | null = null): TurnSource => ({
  ref: `user:${id}`,
  href: userLookupUrl(id),
  label: username,
});

function reportSource(row: { id: number; type: string; userId?: number | null }): TurnSource {
  return {
    ref: `report:${row.id}`,
    // An account report opens in the user queue; any other kind in its owner's Reports section.
    href:
      row.type === 'reportedUser' && row.userId
        ? userReportUrl(row.userId)
        : row.userId
        ? userLookupUrl(row.userId, 'reports')
        : `/reports`,
    label: null,
  };
}

const runSource = (runId: number): TurnSource => ({
  ref: `run:${runId}`,
  href: `/abuse/${runId}`,
  label: null,
});

const imageSource = (id: number): TurnSource => ({
  ref: `image:${id}`,
  href: imageLookupUrl(id),
  label: null,
});

/**
 * Text a USER wrote — a bio, a report comment — fenced so the model can tell evidence from instructions.
 * The fence characters are stripped from inside, so the text cannot close its own fence.
 */
export function quoted(text: string | null | undefined, max = 600): string | null {
  if (!text) return null;
  const clean = text.replace(/[⟦⟧]/g, '').slice(0, max);
  return `⟦${clean}${text.length > max ? '…' : ''}⟧`;
}

const day = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 10) : null;

const userId = z.number().int().positive().max(MAX_INT4);
const userIdList = (max: number, min = 1) => z.array(userId).min(min).max(max);
const reactionDays = z
  .number()
  .int()
  .min(1)
  .max(MAX_REACTION_DAYS)
  .default(DEFAULT_REACTION_DAYS)
  .describe(
    `Days of reactions to search, 1-${MAX_REACTION_DAYS}. Logins are always searched in full.`
  );

async function linkedOut(
  linked: LinkedAccounts,
  ctx: ToolContext,
  subject: number | null
): Promise<ToolResult> {
  const shown = showAddresses(ctx) ? linked : maskLinkedAddresses(linked, ctx.mask);
  return {
    data: {
      days: shown.days,
      totals: shown.totals,
      matched: shown.matched,
      truncated: shown.truncated,
      addresses: shown.addresses.filter((a) => a.accounts > 0),
      accounts: (await withEmails(ctx, shown.accounts)).map((a) => ({
        ...a,
        accountsOnNarrowestAddress: a.narrowest,
        narrowest: undefined,
      })),
    },
    rows: shown.accounts.length,
    truncated: shown.truncated || shown.matched > shown.accounts.length,
    sources: [
      ...(subject ? [userSource(subject)] : []),
      ...shown.accounts.map((a) => userSource(a.userId, a.username)),
    ],
  };
}

function reportRow(r: UserReportRow) {
  const details = (r.details ?? {}) as { comment?: unknown };
  return {
    reportId: r.id,
    createdAt: day(r.createdAt),
    reason: r.reason,
    status: r.status,
    entity: r.entityType,
    entityId: r.entityId,
    reporterId: r.reporterId,
    reporter: r.reporter,
    statusSetBy: r.statusSetBy,
    comment: quoted(typeof details.comment === 'string' ? details.comment : null),
  };
}

/**
 * Reactors linked to EACH OTHER by shared addresses, grouped (connected components), biggest first. A
 * ring that boosts a creator need not share an address with the creator itself, and a flat per-account
 * list left the model to assemble the groups, which it did not do.
 *
 * Linked only through addresses both accounts list, with a measured breadth, so every link is one the
 * answer can cite. `peers` is not used: it spans every shared address, and one public VPN exit would
 * chain strangers into a "ring". `widestLink` is the site-wide account count of the broadest address
 * holding the group together (merged narrowest first), so a group that rests on a crowded address says so.
 *
 * `addresses` is capped per account, so a link can sit past the cap. A group with a member whose list
 * was cut is not `complete` (a narrower link may be hidden), and two accounts `peers` links that no
 * listed address does come back as `unmeasuredLinks` rather than vanishing. `scanCapped` (the address
 * scan hit its row budget) makes every group incomplete, since a link may sit past the budget.
 */
export function reactorClusters(
  shared: Pick<
    SharedIpAccount,
    'userId' | 'username' | 'withTarget' | 'addresses' | 'addressCount' | 'peers'
  >[],
  { scanCapped = false }: { scanCapped?: boolean } = {}
): {
  clusters: {
    size: number;
    linkedToCreator: boolean;
    widestLink: number;
    complete: boolean;
    members: { userId: number; username: string | null }[];
  }[];
  unmeasuredLinks: [number, number][];
} {
  const parent = new Map(shared.map((s) => [s.userId, s.userId]));
  const widest = new Map<number, number>();
  const root = (id: number): number => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };

  const byAddress = new Map<string, { breadth: number; userIds: number[] }>();
  for (const s of shared)
    for (const a of s.addresses) {
      if (a.totalAccounts === null) continue;
      const entry = byAddress.get(a.cluster) ?? { breadth: a.totalAccounts, userIds: [] };
      entry.userIds.push(s.userId);
      byAddress.set(a.cluster, entry);
    }
  for (const { breadth, userIds } of [...byAddress.values()].sort((a, b) => a.breadth - b.breadth))
    for (const id of userIds.slice(1)) {
      const [a, b] = [root(userIds[0]), root(id)];
      if (a === b) continue;
      parent.set(a, b);
      // Narrowest first, so the latest merge into a group is its widest link.
      widest.set(b, breadth);
    }

  const groups = new Map<number, typeof shared>();
  for (const s of shared) groups.set(root(s.userId), [...(groups.get(root(s.userId)) ?? []), s]);
  const clusters = [...groups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([r, g]) => ({
      size: g.length,
      linkedToCreator: g.some((s) => s.withTarget),
      widestLink: widest.get(r) ?? 0,
      complete: !scanCapped && g.every((s) => s.addressCount <= s.addresses.length),
      members: g.map((s) => ({ userId: s.userId, username: s.username })),
    }))
    .sort((a, b) => b.size - a.size || a.widestLink - b.widestLink);

  const unmeasuredLinks: [number, number][] = [];
  for (const s of shared)
    for (const p of s.peers)
      if (p.userId > s.userId && parent.has(p.userId) && root(p.userId) !== root(s.userId))
        unmeasuredLinks.push([s.userId, p.userId]);
  return { clusters, unmeasuredLinks };
}

/**
 * reactors_of checks shared addresses on this many top reactors, not only the few it lists: a ring
 * rarely sits at the top by concentration, and checking the top 30 missed every cluster the Reactor
 * Lookup page showed for the same creator.
 */
const ADDRESS_CHECK = 300;
/** Past this the address check reports itself unfinished rather than empty. */
const ADDRESS_TIMEOUT_SECONDS = 15;
const SHOWN_ACTORS = 20;
/** Narrowest first, so these are the identifying ones. */
const ADDRESSES_SHOWN = 3;

export const TOOLS = [
  tool({
    name: 'find_user',
    description:
      'Resolve a username or numeric id to an account id. Use before any other tool when the moderator names an account.',
    input: z.object({ query: z.string().min(1).max(100) }),
    requires: [LOOKUP, USER_REPORTS],
    run: async ({ query }, ctx) => {
      const term = query.replace(/^@/, '');
      // `resolveUserId` matches an email; only User Lookup shows a moderator account emails.
      if (term.includes('@') && !ctx.canAccess(LOOKUP))
        return {
          data: { found: false, error: 'Searching by email needs User Lookup.' },
          rows: 0,
          truncated: false,
          sources: [],
        };
      const id = await resolveUserId(term);
      if (!id) return { data: { found: false }, rows: 0, truncated: false, sources: [] };
      const { accounts } = await getAccounts([id]);
      const [account] = await withEmails(ctx, accounts);
      return {
        data: { found: true, account },
        rows: 1,
        truncated: false,
        sources: [userSource(id, account?.username ?? null)],
      };
    },
  }),

  tool({
    name: 'get_user_dossier',
    description:
      'Everything at a glance about one account: age, content counts, image rating mix, removed/blocked images, prior reports and how many were actioned, strikes/mutes/bans, detector findings, accounts sharing its login or reaction addresses (top 25), and how widely spread its received reactions are (distinct reactors, top-10/top-20 share). Start most investigations here. ' +
      EMAILS_NOTE,
    input: z.object({ userId }),
    requires: [LOOKUP, USER_REPORTS],
    run: async ({ userId: id }, ctx) => {
      const d = await getDossier(id);
      if (!d) return { data: { found: false }, rows: 0, truncated: false, sources: [] };
      const linked =
        d.linked && (showAddresses(ctx) ? d.linked : maskLinkedAddresses(d.linked, ctx.mask));
      const abuse = ctx.canAccess('/abuse') ? d.abuse : null;
      const emails = await emailFields(ctx, [id, ...(linked?.accounts ?? []).map((a) => a.userId)]);
      return {
        data: {
          ...d,
          ...emails(id),
          linked: linked && {
            totals: linked.totals,
            matched: linked.matched,
            truncated: linked.truncated,
            accounts: linked.accounts.map(({ login, reaction, ...a }) => ({
              ...a,
              ...emails(a.userId),
              sharedLoginAddresses: login.length,
              sharedReactionAddresses: reaction.length,
            })),
          },
          abuse: abuse ?? (ctx.canAccess('/abuse') ? null : 'not available to this moderator'),
        },
        rows: 1,
        truncated: false,
        sources: [
          userSource(id, d.account?.username ?? null),
          ...(linked?.accounts ?? []).map((a) => userSource(a.userId, a.username)),
          ...(d.breadth?.top ?? []).map((t) => userSource(t.userId)),
          ...(abuse?.latest ?? []).map((f) => runSource(f.runId)),
        ],
      };
    },
  }),

  tool({
    name: 'get_accounts',
    description: `Look up a list of account ids (up to ${MAX_ACCOUNTS}) at once: username, signup date, ban/mute state, ban reason code, strikes. For checking a list the moderator collected or a list another tool produced. Pass \`fields\` to get only the columns the question needs (e.g. ["normalizedEmail"] to group a list by inbox): every column costs tokens on every later step. ${EMAILS_NOTE}`,
    input: z.object({
      userIds: userIdList(MAX_ACCOUNTS),
      fields: z.array(z.enum(ACCOUNT_FIELDS)).min(1).optional(),
    }),
    requires: [LOOKUP, USER_REPORTS],
    run: async ({ userIds, fields }, ctx) => {
      const { accounts, missing } = await getAccounts(userIds);
      const wanted = fields && new Set<string>(fields);
      const askedForEmails = !wanted || wanted.has('email') || wanted.has('normalizedEmail');
      // Not fetched at all unless asked for: a column nobody needs should not be read, least of all an
      // address.
      const rows = askedForEmails ? await withEmails(ctx, accounts) : accounts;
      return {
        data: {
          accounts: wanted
            ? rows.map((row) =>
                Object.fromEntries(
                  Object.entries(row).filter(([key]) => key === 'userId' || wanted.has(key))
                )
              )
            : rows,
          missing,
          // Said outright: rows without an address otherwise read as accounts that share none.
          ...(fields && askedForEmails && !showEmails(ctx) ? { emailsWithheld: true } : {}),
        },
        rows: accounts.length,
        truncated: false,
        sources: accounts.map((a) => userSource(a.userId, a.username)),
      };
    },
  }),

  tool({
    name: 'find_linked_accounts',
    description:
      'Every account that shares an address with this one, by LOGIN (all time) or by REACTION (the window). Sorted strongest link first: an address only these two accounts use beats one hundreds use (a VPN or carrier exit). No cap on how many accounts exist; page with offset. ' +
      EMAILS_NOTE,
    input: z.object({
      userId,
      days: reactionDays,
      offset: z.number().int().min(0).max(10_000).default(0),
      limit: z.number().int().min(1).max(MAX_ACCOUNTS).default(50),
    }),
    requires: [LOOKUP, USER_REPORTS],
    run: async ({ userId: id, days, offset, limit }, ctx) =>
      linkedOut(await getLinkedAccounts(id, { days, offset, limit }), ctx, id),
  }),

  tool({
    name: 'accounts_on_address',
    description:
      `Every account seen on IP addresses (an IPv6 address covers its /64), by login (all time) and by reaction (the window), with ban state. Give one \`address\`, or up to ${MAX_BATCH_ADDRESSES} as \`addresses\` to check a list in one call: an account on several of them is listed once, with each address it was seen on, and \`addresses\` in the result gives the count per address. Page with offset; totals are exact. ` +
      EMAILS_NOTE,
    input: z.object({
      address: z.string().min(3).max(60).optional(),
      addresses: z.array(z.string().min(3).max(60)).min(1).max(MAX_BATCH_ADDRESSES).optional(),
      days: reactionDays,
      offset: z.number().int().min(0).max(10_000).default(0),
      limit: z.number().int().min(1).max(MAX_ACCOUNTS).default(100),
    }),
    requires: [LOOKUP],
    timeoutMs: ACCOUNTS_ON_ADDRESS_TIMEOUT_MS,
    onTimeout: ({ address, addresses }) => ({
      notChecked: [...(addresses ?? []), ...(address ? [address] : [])],
      note: 'None of these addresses were checked: the lookup ran out of time. Say so in your answer, naming them, and offer to try again later.',
    }),
    run: async ({ address, addresses, days, offset, limit }, ctx) => {
      const asked = [...(addresses ?? []), ...(address ? [address] : [])];
      const refuse = (error: string) => ({
        data: { error },
        rows: 0,
        truncated: false,
        sources: [],
      });
      if (!asked.length) return refuse('Give an address, or a list as addresses.');
      if (asked.length > MAX_BATCH_ADDRESSES)
        return refuse(`At most ${MAX_BATCH_ADDRESSES} addresses in one call.`);
      const { linked, invalid } = await getAccountsOnAddresses(asked, { days, offset, limit });
      if (!linked)
        return refuse(
          asked.length === 1 ? 'Not an IP address.' : 'None of these is an IP address.'
        );
      const out = await linkedOut(linked, ctx, null);
      // Named back, so a skipped entry is never read as an address with no accounts on it.
      return invalid.length
        ? { ...out, data: { ...(out.data as object), notAddresses: invalid } }
        : out;
    },
  }),

  tool({
    name: 'shared_addresses',
    description:
      'For a list of accounts the moderator suspects are one operator (2-200), the addresses two or more of them share, by reaction and by login, and the groups those addresses connect them into. A group with viaLoginToo=false is joined ONLY by reaction addresses: the reaction-bot chain shape that login-based tools cannot see.',
    input: z.object({ userIds: userIdList(MAX_ACCOUNTS, 2), days: reactionDays }),
    requires: [LOOKUP, USER_REPORTS],
    run: async ({ userIds, days }, ctx) => {
      const links = await getSetLinks(userIds, days);
      const label = shownAddress(ctx);
      return {
        data: {
          ...links,
          clusters: links.clusters.slice(0, 200).map((c) => ({ ...c, cluster: label(c.cluster) })),
        },
        rows: links.clusters.length,
        truncated: links.clusters.length > 200,
        sources: userIds.map((id) => userSource(id)),
      };
    },
  }),

  tool({
    name: 'reactors_of',
    description:
      "Who reacts to this creator's content in the window, scored by concentration (the share of each reactor's own reactions that land on this creator; 100% from one account is the ring signal, raw count is not), and which of them share addresses. `clusters` comes first: groups of reactors that share addresses with EACH OTHER, whether or not with the creator, each member with its rank and concentration. When asked about interconnected accounts, report these first, with each one's `widestLink` (how many accounts the site has seen on the broadest address holding it together; a crowded address such as a VPN exit or mobile carrier is weak evidence on its own). A cluster that is not `complete` may hide a narrower link; `unmeasuredLinks` are account pairs that share an address the clusters could not measure. Report both as unverified rather than as no link. `addressesChecked` says how many of the over-floor reactors were checked for shared addresses and whether that check is `complete`. Say a creator's reactors have no clusters only when it is complete, and then say how many were checked out of how many; when it timed out or the scan was cut short (`scanCapped`), say the check did not finish, never that there are no clusters. `actors` is only the top reactors by concentration. Use days 3 for who is boosting the creator now, 30 or 90 for a slow farm. Use for bot accusations in both directions: a ring boosting someone, and a creator falsely accused who simply has a wide audience.",
    input: z.object({
      userId,
      days: z.number().int().min(1).max(MAX_REACTION_DAYS).default(30),
      minCount: z.number().int().min(1).max(1000).default(5),
    }),
    requires: [REACTOR_LOOKUP, LOOKUP],
    run: async ({ userId: id, days, minCount }, ctx) => {
      const [report, breadth] = await Promise.all([
        getInflationActors(id, { category: 'reactions', days, minCount, limit: ADDRESS_CHECK }),
        getReactionBreadth(id, days),
      ]);
      const checked = report.actors.map((a) => a.userId);
      let shared: SharedIpAccount[] = [];
      let scanCapped = false;
      let timedOut = false;
      if (checked.length)
        try {
          ({ accounts: shared, scanCapped } = await getSharedIpCoverage(checked, {
            targetId: id,
            timeoutSeconds: ADDRESS_TIMEOUT_SECONDS,
          }));
        } catch (e) {
          // A timeout checked nobody; it must not read as "no shared addresses".
          if (!isClickhouseTimeout(e)) throw e;
          timedOut = true;
        }
      const { clusters, unmeasuredLinks } = reactorClusters(shared, { scanCapped });
      const byId = new Map(report.actors.map((a, i) => [a.userId, { a, rank: i + 1 }]));
      const inCluster = new Set(clusters.flatMap((c) => c.members.map((m) => m.userId)));
      const shown = report.actors.slice(0, SHOWN_ACTORS);
      // Only accounts in a finding: with 300 checked, every sharer would swamp the answer.
      const findings = shared.filter((s) => s.withTarget || inCluster.has(s.userId));
      const label = shownAddress(ctx);
      return {
        data: {
          addressesChecked: {
            reactors: timedOut ? 0 : checked.length,
            overFloor: report.total,
            scanCapped,
            timedOut,
            complete: !scanCapped && !timedOut,
          },
          clusters: clusters.map((c) => ({
            ...c,
            members: c.members.map((m) => ({
              ...m,
              rank: byId.get(m.userId)?.rank ?? null,
              concentration: byId.get(m.userId)?.a.concentration ?? null,
              reactions: byId.get(m.userId)?.a.count ?? null,
            })),
          })),
          unmeasuredLinks,
          breadth,
          overFloor: report.total,
          belowFloor: report.belowFloor,
          actors: shown.map((a) => ({
            userId: a.userId,
            username: a.username,
            reactions: a.count,
            distinctItems: a.entities,
            concentration: a.concentration,
            creatorsReactedTo: a.owners,
            status: a.status,
            strikes: a.strikes,
            createdAt: day(a.createdAt),
            instantVerify: a.instantVerify,
          })),
          sharedAddresses: findings.map((s) => ({
            userId: s.userId,
            username: s.username,
            withCreator: s.withTarget,
            addressCount: s.addressCount,
            addresses: s.addresses
              .slice(0, ADDRESSES_SHOWN)
              .map((a) => ({ ...a, cluster: label(a.cluster) })),
          })),
        },
        rows: shown.length,
        truncated: report.total > checked.length || scanCapped || timedOut,
        sources: [
          userSource(id),
          ...shown.map((a) => userSource(a.userId, a.username)),
          // Every account a finding names, so a citation of one past the top rows still verifies.
          ...findings.map((s) => userSource(s.userId, s.username)),
          ...unmeasuredLinks.flat().map((u) => userSource(u, byId.get(u)?.a.username)),
          ...breadth.top.map((t) => userSource(t.userId)),
        ],
      };
    },
  }),

  tool({
    name: 'buzz_flows',
    description:
      "Where a set of accounts' Buzz came from and went (1-100 accounts): blue Buzz each was rewarded, Buzz sent to and received from other accounts by account type (blue = reward Buzz), trainings and how many were paid with blue Buzz, and the account-to-account flows (tips, model purchases with the model version ids) with withinSet marking flows between two listed accounts. For alts pooling Buzz into a main and burners farming free trainings.",
    input: z.object({
      userIds: userIdList(100),
      days: z.number().int().min(1).max(MAX_BUZZ_DAYS).default(90),
    }),
    requires: [LOOKUP],
    run: async ({ userIds, days }, ctx) => {
      const flows = await getBuzzFlows(userIds, days, {
        includeBank: ctx.hasGrant('user.buzz.bank'),
      });
      const counterparties = new Set(flows.flows.flatMap((f) => [f.from, f.to]));
      return {
        data: flows,
        rows: flows.flows.length,
        truncated: flows.truncated,
        sources: [...new Set([...userIds, ...counterparties])].map((id) => userSource(id)),
      };
    },
  }),

  tool({
    name: 'placement_flows',
    description:
      'Paid placements (stickers, remixes, gallery promotions) made by or on a set of accounts (1-100 accounts), with both ends named. These payments go through an escrow account, so buzz_flows never shows who paid whom for them; when buzz_flows or Buzz history shows placement debits or credits with no counterparty, this tool names it. Per account: placements made and received by currency, Buzz held and refunded as placer, Buzz earned as owner. Per placer-owner pair: count, free count, statuses, Buzz held, refunded and paid out to the owner, seller and platform, the stickers used, and withinSet when both are listed. A listed account that was only the seller is not matched.',
    input: z.object({
      userIds: userIdList(100),
      days: z.number().int().min(1).max(MAX_BUZZ_DAYS).default(90),
    }),
    requires: [LOOKUP],
    run: async ({ userIds, days }) => {
      const flows = await getPlacementFlows(userIds, days);
      const named = flows.pairs.flatMap((p) => [
        userSource(p.placerId, p.placerName),
        userSource(p.ownerId, p.ownerName),
      ]);
      return {
        data: flows,
        rows: flows.pairs.length,
        truncated: flows.truncated,
        sources: [...flows.accounts.map((a) => userSource(a.userId, a.username)), ...named],
      };
    },
  }),

  tool({
    name: 'reports_about',
    description:
      'Reports involving one account. direction "against_account": reports filed on the account itself. "against_content": reports on content it owns. "filed_by": reports this account filed (an accuser\'s record). Comments are quoted user text.',
    input: z.object({
      userId,
      direction: z.enum(['against_account', 'against_content', 'filed_by']),
      status: z.enum(['open', 'all']).default('all'),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    requires: [USER_REPORTS, LOOKUP],
    run: async ({ userId: id, direction, status, limit }) => {
      const statuses = status === 'open' ? DEFAULT_REPORT_STATUSES : [];
      const rows =
        direction === 'against_account'
          ? await getReportsOnUser(id, { limit, statuses })
          : direction === 'against_content'
          ? await getReportsReceived(id, { limit, statuses })
          : await getReportsSubmitted(id, { limit, statuses });
      return {
        data: { reports: rows.map(reportRow) },
        rows: rows.length,
        truncated: rows.length >= limit,
        sources: [
          userSource(id),
          ...rows.map((r) =>
            reportSource({
              id: r.id,
              type: r.type,
              // A filed report's subject is known only for an account report; any other kind opens
              // in the filer's Reports section.
              userId: direction === 'filed_by' && r.type === 'reportedUser' ? r.entityId : id,
            })
          ),
          ...rows.flatMap((r) => (r.reporterId ? [userSource(r.reporterId, r.reporter)] : [])),
          ...rows.flatMap((r) =>
            r.type === 'image' && r.entityId ? [imageSource(r.entityId)] : []
          ),
        ],
      };
    },
  }),

  tool({
    name: 'open_user_reports',
    description:
      "The open user-report queue, human-filed only, newest first: report id, reported account, reporter, reason, status and the reporter's comment (quoted user text). Filter by status and reason rather than paging the whole queue; for a sweep (spam, bots), filter by reason first, then look up the reported accounts. Page with the returned nextCursor, passing the same order and filters.",
    input: z.object({
      limit: z.number().int().min(1).max(100).default(50),
      order: z.enum(['newest', 'oldest']).default('newest'),
      cursor: z.number().int().positive().max(MAX_INT4).optional(),
      statuses: z
        .array(z.enum(['Pending', 'Processing']))
        .min(1)
        .max(2)
        .optional(),
      reasons: z
        .array(z.enum(HUMAN_REPORT_REASONS as [string, ...string[]]))
        .min(1)
        .max(HUMAN_REPORT_REASONS.length)
        .optional(),
    }),
    requires: [USER_REPORTS],
    run: async (query) => {
      const { limit } = query;
      const rows = await getOpenUserReports(query);
      return {
        data: {
          reports: rows.map((r) => ({
            ...r,
            createdAt: day(r.createdAt),
            comment: quoted(r.comment),
          })),
          nextCursor: rows.length >= limit ? rows.at(-1)!.reportId : null,
        },
        rows: rows.length,
        truncated: rows.length >= limit,
        sources: rows.flatMap((r) => [
          reportSource({ id: r.reportId, type: 'reportedUser', userId: r.userId }),
          userSource(r.userId),
          userSource(r.reporterId),
        ]),
      };
    },
  }),

  tool({
    name: 'abuse_findings',
    description:
      'What automated detectors (bot accounts, reaction abuse, review bombing) have said about one account, newest first, with any moderator verdict.',
    input: z.object({ userId }),
    requires: ['/abuse'],
    run: async ({ userId: id }) => {
      const { findings, truncated } = await getAbuseFindingsForUser(id, 50);
      return {
        data: { findings, truncated },
        rows: findings.length,
        truncated,
        sources: [userSource(id), ...findings.map((f) => runSource(f.runId))],
      };
    },
  }),

  tool({
    name: 'search_accounts',
    description:
      'Find accounts by username and signup date: the "I banned an account named like this before" search. usernamePrefix is fast on any population. usernameContains needs banned "only" or a signup window of at most 31 days. Dates are YYYY-MM-DD.',
    input: z.object({
      usernamePrefix: z.string().min(2).max(50).optional(),
      usernameContains: z.string().min(3).max(50).optional(),
      banned: z.enum(['only', 'exclude', 'any']).default('any'),
      createdAfter: z.iso.date().optional(),
      createdBefore: z.iso.date().optional(),
      limit: z.number().int().min(1).max(MAX_ACCOUNTS).default(50),
    }),
    requires: [LOOKUP],
    run: async (args) => {
      const result = await searchAccounts({
        ...args,
        createdAfter: args.createdAfter ? new Date(args.createdAfter) : undefined,
        createdBefore: args.createdBefore ? new Date(args.createdBefore) : undefined,
      });
      if ('refused' in result)
        return { data: { error: result.refused }, rows: 0, truncated: false, sources: [] };
      return {
        data: result,
        rows: result.accounts.length,
        truncated: result.truncated,
        sources: result.accounts.map((a) => userSource(a.userId, a.username)),
      };
    },
  }),

  tool({
    name: 'list_playbooks',
    description:
      'The investigation playbooks moderators have written: slug, title and when to use each.',
    input: z.object({}),
    requires: null,
    run: async (_args, ctx) => {
      const playbooks = await listPlaybooks();
      return {
        data: playbooks.map(({ slug, title, summary, version }) => ({
          slug,
          title,
          summary: shownText(ctx, summary),
          version,
        })),
        rows: playbooks.length,
        truncated: false,
        sources: [],
      };
    },
  }),

  tool({
    name: 'read_playbook',
    description: 'The full steps of one playbook. Read it before following it.',
    input: z.object({ slug: z.string().min(1).max(60) }),
    requires: null,
    run: async ({ slug }, ctx) => {
      const playbook = await getPlaybook(slug);
      return {
        data: playbook
          ? {
              ...playbook,
              summary: shownText(ctx, playbook.summary),
              body: shownText(ctx, playbook.body),
            }
          : { error: `No playbook "${slug}".` },
        rows: playbook ? 1 : 0,
        truncated: false,
        sources: [],
      };
    },
  }),

  tool({
    name: 'propose_playbook',
    description:
      'Draft a new playbook, or a new version of one, when the moderator asks you to save a way of investigating. It is saved as a PROPOSAL: nothing changes until a moderator accepts it on the Playbooks page. Only when the moderator asked for it.',
    input: z.object({
      slug: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .max(60),
      title: z.string().min(3).max(120),
      summary: z.string().min(10).max(300),
      body: z.string().min(20).max(8000),
      note: z.string().max(500).optional(),
    }),
    requires: null,
    run: async ({ slug, title, summary, body, note }, ctx) => {
      // A playbook is read by every assistant user and goes into every moderator's prompt, so an
      // email from this chat must not ride along; the method never needs one.
      const { version } = await addPlaybookVersion({
        slug,
        draft: {
          title: redactEmails(title),
          summary: redactEmails(summary),
          body: redactEmails(body),
          note: note ? redactEmails(note) : null,
        },
        authorId: ctx.moderatorId,
        byAssistant: true,
        sourceTurnId: ctx.turnId,
      });
      return {
        data: { proposed: true, slug, version, reviewAt: `/assistant/playbooks/${slug}` },
        rows: 1,
        truncated: false,
        sources: [],
      };
    },
  }),

  tool({
    name: 'request_tool',
    description:
      'Ask the people who maintain you for a capability you do not have, when the moderator needs something no tool here can answer. Say what the tool should do, why this case needed it, and an example input. The conversation so far is attached automatically.',
    input: z.object({
      need: z.string().min(10).max(1000),
      reason: z.string().min(10).max(1000),
      example: z.string().max(1000).optional(),
    }),
    requires: null,
    run: async ({ need, reason, example }, ctx) => {
      // Read by every assistant user (the conversation by every auditor), none of whom need an email
      // to build a tool.
      const id = await fileToolRequest({
        chatId: ctx.chatId,
        turnId: ctx.turnId,
        moderatorId: ctx.moderatorId,
        need: redactEmails(need),
        reason: redactEmails(reason),
        example: example ? redactEmails(example) : null,
        conversation: ctx.conversation().map((c) => ({
          prompt: redactEmails(c.prompt),
          answer: c.answer && redactEmails(c.answer),
        })),
      });
      return { data: { filed: true, requestId: id }, rows: 1, truncated: false, sources: [] };
    },
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];

export const toolsFor = (ctx: Pick<ToolContext, 'canAccess'>) =>
  TOOLS.filter((t) => !t.requires || t.requires.some((path) => ctx.canAccess(path)));

/**
 * Every tool a playbook may name, with its inputs and the pages that unlock it, for the playbook editor.
 * Not filtered to the author: a playbook runs for every moderator, and each gets only the tools `toolsFor`
 * allows them.
 */
export function toolCatalog(): {
  name: string;
  description: string;
  inputs: string[];
  /** Any one of these pages unlocks it; `null` is every moderator. */
  needs: string[] | null;
}[] {
  return TOOLS.map((t) => {
    const parameters = toolSpec(t).function.parameters as { properties?: Record<string, unknown> };
    return {
      name: t.name,
      description: t.description,
      inputs: Object.keys(parameters.properties ?? {}),
      needs: t.requires,
    };
  });
}

export function toolSpec(t: (typeof TOOLS)[number]) {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(t.input, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return {
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters },
  };
}
