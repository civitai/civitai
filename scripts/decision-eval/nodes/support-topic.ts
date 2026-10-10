import { createClient } from '@clickhouse/client';
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { GoldPolicy } from '../builder';
import type { NodeContext, NodeSpec, SourceRow } from '../nodes';
import { nodePaths } from '../paths';
import { choiceMapper, choiceTargets } from '../runner';
import { readJson } from '../store';
import type { ChoiceOption, DecisionState, FormatSpec, GoldRow, MappedAnswer } from '../types';

export const NODE_ID = 'support.topic';

export const CANNOT_TELL = 'cannot_tell';

const TOPIC_OPTIONS: readonly ChoiceOption[] = [
  {
    key: 'billing_buzz',
    description: 'Buying Buzz or memberships by card or PayPal; balance or charge questions',
  },
  { key: 'crypto', description: 'A crypto deposit or payment' },
  { key: 'payment_refund', description: 'Asking for money back, or disputing a charge' },
  { key: 'account', description: 'Login, email, username, account deletion, account restriction' },
  { key: 'technical_bug', description: 'Something on the site is broken or erroring' },
  {
    key: 'generation_quality',
    description: 'Generated output is poor or wrong, the generator works',
  },
  { key: 'model_quality', description: 'A model or resource behaves badly or is mislabelled' },
  {
    key: 'moderation',
    description: 'Their content was rated, hidden or removed, or a moderation question',
  },
  { key: 'abuse_report', description: "Reporting someone else's content or behaviour" },
  { key: 'feature_request', description: 'Asking for something new' },
  { key: 'other', description: 'None of the above' },
  { key: CANNOT_TELL, description: 'The ticket does not say enough to decide' },
];

export const TOPIC_CLASSES: readonly string[] = TOPIC_OPTIONS.map((o) => o.key);

/**
 * The incumbent classifier's 13 slugs onto this node's classes. The two
 * moderation slugs merge because that pair is where human labels disagree
 * most; mobile-app has one label ever.
 */
export const INCUMBENT_TOPIC_MAP: Readonly<Record<string, string>> = {
  'billing-buzz': 'billing_buzz',
  crypto: 'crypto',
  'payment-refund': 'payment_refund',
  'account-issue': 'account',
  'technical-bug': 'technical_bug',
  'generation-quality': 'generation_quality',
  'model-quality': 'model_quality',
  'nsfw-moderation': 'moderation',
  'image-moderation-appeal': 'moderation',
  'abuse-report': 'abuse_report',
  'feature-request': 'feature_request',
  'mobile-app': 'technical_bug',
  other: 'other',
};

/** The label ingest stores a cannot-tell as an empty label_topic with this notes prefix. */
const CANNOT_TELL_NOTES_PREFIX = 'cannot-tell';

const SUBJECT_CHARS = 500;
const FIRST_MESSAGE_CHARS = 6000;
const LATEST_MESSAGES_CHARS = 3000;

export type SupportTicketRaw = {
  ticketId: string;
  createdAt: string;
  subject: string;
  firstMessage: string;
  latestMessages: string;
  memberTier: string;
  lang: string;
  incumbentTopic: string;
  requesterId: string;
  requesterEmail: string;
  username: string;
  /** Sampling stratum from the label sheet's strata file; absent for dev items. */
  stratum?: string;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the requester's own identifiers as whole words, then anything shaped
 * like an email, a link (with or without a scheme), a handle, a long
 * wallet/transaction id or a phone number. Real names are NOT removed: the
 * classified-tickets table stores no requester name, and free-text name
 * detection is not attempted.
 */
/** A requester id equal to a placeholder word would re-wrap earlier placeholders on the second pass. */
const PLACEHOLDER_WORDS = new Set(['user', 'email', 'link', 'handle', 'id', 'number']);

export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const k of known) {
    const id = k.trim();
    if (id.length < 3 || PLACEHOLDER_WORDS.has(id.toLowerCase())) continue;
    const whole = String.raw`(?<![\w.])` + escapeRegExp(id) + String.raw`(?!\w)`;
    out = out.replace(new RegExp(whole, 'gi'), '[user]');
  }
  return out
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/gi, '[link]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*/gi, '[link]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\/\S*/g, '[link]')
    .replace(/(^|[^\w@])@[A-Za-z0-9_]{2,}/g, '$1[handle]')
    .replace(/\b(?:bc1|tb1|ltc1|addr1)[a-z0-9]{20,}\b/gi, '[id]')
    .replace(/\b(?:0x)?[a-f0-9]{24,}\b/gi, '[id]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{26,}\b/g, '[id]')
    .replace(/\+?\d[\d ().-]{8,}\d/g, '[number]');
}

const REDACT_MARGIN_CHARS = 1000;

/** Cannot be part of an email, handle or id; CJK text counts as one. A link can contain any of these but whitespace. */
const SEPARATOR = /[^\w.@%+:/#=&?~-]/;

const PHONE_CHAR = /[\d\s().+-]/;
const LINK_START = /:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}(?::\d+)?\/|\d\.\d{1,3}(?::\d+)?\//i;

/** The whitespace-free run of `text` that ends at `end`. */
function tokenEndingAt(text: string, end: number): string {
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return text.slice(start, end);
}

const WORD_CHAR = /\w/;

/**
 * Drops the run of phone characters at a window's cut end, where a cut phone
 * number leaves digits too few for the phone pattern. Only the part glued to a
 * word with no whitespace between (`johnsmith1990`, `pat-1990`, an id) is
 * kept: cutting it would hide the word from redaction.
 */
function dropPhoneRunAtEnd(s: string): string {
  let i = s.length;
  while (i > 0 && PHONE_CHAR.test(s[i - 1])) i--;
  if (i === s.length) return s;
  if (i === 0 || !WORD_CHAR.test(s[i - 1])) return s.slice(0, i);
  const glued = s.slice(i).search(/\s/);
  return glued < 0 ? s : s.slice(0, i + glued);
}

function dropPhoneRunAtStart(s: string): string {
  let i = 0;
  while (i < s.length && PHONE_CHAR.test(s[i])) i++;
  if (i === 0) return s;
  if (i === s.length || !WORD_CHAR.test(s[i])) return s.slice(i);
  let glued = i;
  while (glued > 0 && !/\s/.test(s[glued - 1])) glued--;
  return s.slice(glued);
}

/**
 * Several patterns are quadratic on a long non-matching run, so redaction gets a
 * bounded window: the kept length plus a margin.
 *
 * Redaction can shrink the window by more than the margin, so the window's cut
 * end can reach the output, and a pattern cannot see an identifier missing its
 * start. So the cut never splits a word: it is made at whitespace within the
 * margin, then drops a cut phone number. Text with no whitespace near the cut is
 * cut at SEPARATOR instead, which keeps CJK text; a tail is dropped whole there
 * if the run it starts inside is a link, since a link runs to whitespace.
 */
export function redactionWindow(text: string, keep: number, fromEnd: boolean): string {
  const limit = keep + REDACT_MARGIN_CHARS;
  if (text.length <= limit) return text;
  if (fromEnd) {
    const tail = text.slice(-limit);
    const space = tail.search(/\s/);
    if (space >= 0 && space < REDACT_MARGIN_CHARS)
      return dropPhoneRunAtStart(tail.slice(space + 1));
    const firstSeparator = tail.search(SEPARATOR);
    const spanning =
      tokenEndingAt(text, text.length - limit) +
      (firstSeparator < 0 ? tail : tail.slice(0, firstSeparator + 1));
    if (LINK_START.test(spanning))
      return space < 0 ? '' : dropPhoneRunAtStart(tail.slice(space + 1));
    return firstSeparator < 0 ? '' : dropPhoneRunAtStart(tail.slice(firstSeparator + 1));
  }
  const head = text.slice(0, limit);
  let space = head.length - 1;
  while (space >= 0 && !/\s/.test(head[space])) space--;
  if (space >= keep) return dropPhoneRunAtEnd(head.slice(0, space));
  for (let i = head.length - 1; i >= 0; i--) {
    if (SEPARATOR.test(head[i])) return dropPhoneRunAtEnd(head.slice(0, i));
  }
  return '';
}

/**
 * Redact the bounded window, cut to length, then redact the cut again: the
 * final cut can itself create a match, e.g. a tail that now starts "@name".
 */
function redactField(text: string, keep: number, fromEnd: boolean, known: readonly string[]) {
  const once = redact(redactionWindow(text, keep, fromEnd), known);
  return redact(fromEnd ? once.slice(-keep) : once.slice(0, keep), known);
}

export function buildSupportState(raw: SupportTicketRaw): DecisionState {
  const known = [
    raw.requesterEmail,
    raw.requesterEmail.split('@')[0] ?? '',
    raw.username,
    raw.requesterId,
  ];
  return {
    subject: redactField(raw.subject, SUBJECT_CHARS, false, known),
    first_message: redactField(raw.firstMessage, FIRST_MESSAGE_CHARS, false, known),
    latest_messages: redactField(raw.latestMessages, LATEST_MESSAGES_CHARS, true, known),
    member_tier: raw.memberTier || 'unknown',
  };
}

const KEYWORD_RULES: ReadonlyArray<[string, RegExp]> = [
  [
    'crypto',
    /\b(crypto|usdt|usdc|btc|bitcoin|eth|ethereum|solana|ltc|wallet|nowpayments|blockchain|tx ?hash)\b/i,
  ],
  ['payment_refund', /\b(refund|chargeback|charged twice|double charged|money back)\b/i],
  [
    'billing_buzz',
    /\bbuzz\b.*\b(buy|bought|purchase|paid|payment|charged|card)\b|\b(buy|bought|purchase|paid|payment|charged|card)\b.*\bbuzz\b/is,
  ],
];

/** A cheap rule to beat: if keywords alone reach the money classes' precision, the model adds little there. */
export function keywordBaseline(raw: SupportTicketRaw): string | null {
  const text = `${raw.subject}\n${raw.firstMessage}`;
  for (const [label, re] of KEYWORD_RULES) if (re.test(text)) return label;
  return null;
}

/** null means not labelled yet; a label outside the incumbent vocab throws rather than silently leaving gold. */
export function goldFromLabel(labelTopic: string, notes: string): string | null {
  if (!labelTopic)
    return notes.trim().toLowerCase().startsWith(CANNOT_TELL_NOTES_PREFIX) ? CANNOT_TELL : null;
  const gold = INCUMBENT_TOPIC_MAP[labelTopic];
  if (!gold) throw new Error(`label_topic "${labelTopic}" is not an incumbent topic`);
  return gold;
}

export function periodOf(raw: SupportTicketRaw): string {
  return raw.stratum ? raw.createdAt.slice(0, 7) : 'dev';
}

export type StrataRow = { stratum: string; weight: number };

/** One row per ticket in the label sampler's strata sidecar; the weight is the inverse inclusion probability. */
export function parseStrataCsv(text: string): Map<string, StrataRow> {
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = header.split(',');
  const idCol = cols.indexOf('ticket_id');
  const stratumCol = cols.indexOf('stratum');
  const weightCol = cols.indexOf('weight');
  if (idCol < 0 || stratumCol < 0 || weightCol < 0)
    throw new Error('strata file needs ticket_id, stratum and weight columns');
  return new Map(
    lines.map((l) => {
      const cells = l.split(',');
      const weight = Number(cells[weightCol]);
      if (!(weight >= 1)) throw new Error(`ticket ${cells[idCol]} has weight ${cells[weightCol]}`);
      return [cells[idCol], { stratum: cells[stratumCol], weight }];
    })
  );
}

/**
 * Private, per-machine settings under `<data-dir>/support.topic/config.json`:
 * the classifier version whose stored state is read, and the strata files whose
 * tickets form the sealed test split.
 */
type SupportTopicConfig = {
  classifierVersion: string;
  testStrataFiles: string[];
  /** Exactly the ingest id whose label is gold when the double-labelled tickets disagree. */
  primaryLabeler?: string;
};

function nodeDir(ctx: NodeContext): string {
  return nodePaths(ctx.dataDir, NODE_ID).root;
}

export function readStrata(ctx: NodeContext, cfg: SupportTopicConfig): Map<string, StrataRow> {
  const out = new Map<string, StrataRow>();
  for (const file of cfg.testStrataFiles) {
    for (const [id, row] of parseStrataCsv(readFileSync(join(nodeDir(ctx), file), 'utf8'))) {
      out.set(id, row);
    }
  }
  return out;
}

export function readConfig(ctx: NodeContext): SupportTopicConfig {
  const path = join(nodeDir(ctx), 'config.json');
  const cfg = readJson<Partial<SupportTopicConfig>>(path);
  if (!cfg) throw new Error(`${path} is missing; see the support-topic node header`);
  if (
    !cfg.classifierVersion ||
    !Array.isArray(cfg.testStrataFiles) ||
    !cfg.testStrataFiles.length
  ) {
    throw new Error(`${path} needs classifierVersion and a non-empty testStrataFiles`);
  }
  return cfg as SupportTopicConfig;
}

/** The salt never enters the repo, so a group key cannot be reversed by hashing known requester ids. */
function groupSalt(ctx: NodeContext): string {
  const path = join(nodeDir(ctx), 'group-salt');
  if (!existsSync(path)) {
    // A new salt would re-key every group, and a requester could then sit in dev and test across builds.
    if (existsSync(nodePaths(ctx.dataDir, NODE_ID).manifest)) {
      throw new Error(
        `${path} is missing but a manifest exists; restore the salt, do not regenerate it`
      );
    }
    mkdirSync(nodeDir(ctx), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('hex'));
  }
  return readFileSync(path, 'utf8').trim();
}

export function groupKeyFor(salt: string, requesterId: string, ticketId: string): string {
  const who = requesterId ? `requester:${requesterId}` : `ticket:${ticketId}`;
  return createHash('sha256').update(`${salt}\n${who}`).digest('hex').slice(0, 24);
}

function clickhouse() {
  const url = process.env.CLICKHOUSE_HOST;
  if (!url) throw new Error('CLICKHOUSE_HOST is not set');
  return createClient({
    url,
    username: process.env.CLICKHOUSE_USERNAME ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    request_timeout: 60_000,
  });
}

const HUMAN_LABELS_SQL = `
  SELECT ticket_id, label_topic, notes, labeler
  FROM support_ticket_eval_labels FINAL
  WHERE classifier_version = {cv:String} AND lower(labeler) NOT LIKE 'judge-%'`;

type LabelRow = { ticket_id: string; label_topic: string; notes: string; labeler: string };

async function humanLabels(cfg: SupportTopicConfig): Promise<LabelRow[]> {
  const ch = clickhouse();
  try {
    const rs = await ch.query({
      query: HUMAN_LABELS_SQL,
      query_params: { cv: cfg.classifierVersion },
      format: 'JSONEachRow',
    });
    return (await rs.json()) as LabelRow[];
  } finally {
    await ch.close();
  }
}

type TicketRow = {
  ticket_id: string;
  created_ms: string;
  ticket_subject: string;
  body_clean: string;
  conversation_tail: string;
  member_tier: string;
  lang: string;
  topic: string;
  requester_freshdesk_id: string;
  requester_email: string;
  civitai_username: string | null;
};

const TICKETS_SQL = `
  SELECT ticket_id, toUnixTimestamp64Milli(ticket_created_at) AS created_ms, ticket_subject, body_clean, conversation_tail,
         member_tier, lang, topic, requester_freshdesk_id, requester_email, civitai_username
  FROM support_tickets_classified FINAL
  WHERE classifier_version = {cv:String} AND ticket_id IN {ids:Array(String)}`;

async function* supportSource(ctx: NodeContext): AsyncIterable<SourceRow<SupportTicketRaw>> {
  const cfg = readConfig(ctx);
  const salt = groupSalt(ctx);
  const strata = readStrata(ctx, cfg);
  const stratumOf = new Map([...strata].map(([id, row]) => [id, row.stratum]));
  const devIds = new Set(
    (await humanLabels(cfg)).map((l) => l.ticket_id).filter((id) => !stratumOf.has(id))
  );
  const ch = clickhouse();
  let rows: TicketRow[];
  try {
    const rs = await ch.query({
      query: TICKETS_SQL,
      query_params: { cv: cfg.classifierVersion, ids: [...stratumOf.keys(), ...devIds] },
      format: 'JSONEachRow',
    });
    rows = (await rs.json()) as TicketRow[];
  } finally {
    await ch.close();
  }
  const wanted = new Set([...stratumOf.keys(), ...devIds]);
  const got = new Set(rows.map((r) => r.ticket_id));
  if (
    rows.length !== got.size ||
    got.size !== wanted.size ||
    [...wanted].some((id) => !got.has(id))
  ) {
    throw new Error(
      `expected exactly one stored row per ticket: ${rows.length} rows, ${got.size} distinct, ${wanted.size} wanted`
    );
  }
  const out = rows.map((r): SourceRow<SupportTicketRaw> => {
    const createdAt = new Date(Number(r.created_ms)).toISOString();
    return {
      itemId: r.ticket_id,
      groupKey: groupKeyFor(salt, r.requester_freshdesk_id, r.ticket_id),
      ts: createdAt,
      split: stratumOf.has(r.ticket_id) ? 'test' : 'dev',
      raw: {
        ticketId: r.ticket_id,
        createdAt,
        subject: r.ticket_subject,
        firstMessage: r.body_clean,
        latestMessages: r.conversation_tail,
        memberTier: r.member_tier,
        lang: r.lang,
        incumbentTopic: r.topic,
        requesterId: r.requester_freshdesk_id,
        requesterEmail: r.requester_email,
        username: r.civitai_username ?? '',
        stratum: stratumOf.get(r.ticket_id),
      },
    };
  });
  assertDevPrecedesTest(out);
  const { kept, dropped } = dropDevSharingTestGroup(out);
  if (dropped)
    console.error(`support.topic: ${dropped} dev item(s) dropped: their requester is in test`);
  yield* kept;
}

/** A labelled ticket from the test period that is in no strata file means a strata file was left out of the config. */
export function assertDevPrecedesTest(
  rows: readonly { itemId: string; split?: string; ts: string }[]
) {
  const testTimes = rows.filter((r) => r.split === 'test').map((r) => Date.parse(r.ts));
  if (!testTimes.length) return;
  const firstTest = testTimes.reduce((a, b) => Math.min(a, b));
  const late = rows.filter((r) => r.split === 'dev' && Date.parse(r.ts) >= firstTest);
  if (late.length) {
    throw new Error(
      `${late.length} dev ticket(s) created on or after the earliest test ticket (${new Date(
        firstTest
      ).toISOString()}), e.g. ${late[0].itemId}; is a strata file missing from testStrataFiles?`
    );
  }
}

/**
 * The harness keeps a shared requester in the earlier split and drops it from
 * test. Here the sampled test set is the scarce one (it holds every refund the
 * month had), so the dev item gives way instead.
 */
export function dropDevSharingTestGroup<T extends { split?: string; groupKey: string }>(
  rows: readonly T[]
): { kept: T[]; dropped: number } {
  const testGroups = new Set(rows.filter((r) => r.split === 'test').map((r) => r.groupKey));
  const kept = rows.filter((r) => r.split === 'test' || !testGroups.has(r.groupKey));
  return { kept, dropped: rows.length - kept.length };
}

async function* supportGold(ctx: NodeContext): AsyncIterable<GoldRow> {
  const cfg = readConfig(ctx);
  const labels = await humanLabels(cfg);
  // resolveGold falls back to majority per item, so a misspelt id would silently mean no primary at all.
  if (cfg.primaryLabeler && !labels.some((l) => l.labeler === cfg.primaryLabeler)) {
    throw new Error(
      `primaryLabeler "${cfg.primaryLabeler}" has no labels; use the exact ingest id`
    );
  }
  for (const l of labels) {
    const gold = goldFromLabel(l.label_topic, l.notes);
    if (gold)
      yield {
        itemId: l.ticket_id,
        gold,
        goldSource: 'support_ticket_eval_labels',
        labeler: l.labeler,
      };
  }
}

/** The router wording asks the incumbent's 13 slugs with no cannot-tell, so its answers map like the incumbent's. */
function routerMapper(questionId: string): FormatSpec['mapAnswer'] {
  const base = choiceMapper(questionId);
  return (answers): MappedAnswer => {
    const m = base(answers);
    if (m.pred === null) return m;
    const pred = INCUMBENT_TOPIC_MAP[m.pred];
    if (!pred) throw new Error(`router format answered "${m.pred}", which has no mapping`);
    return { ...m, pred };
  };
}

export const supportTopicNode: NodeSpec<SupportTicketRaw> = {
  id: NODE_ID,
  specVersion: 1,
  dataClass: 'support-text',
  classes: TOPIC_CLASSES,
  targets: { billing_buzz: 0.9, crypto: 0.9, payment_refund: 0.9 },
  formats: {
    choice12: {
      questions: [
        {
          id: 'topic',
          type: 'choice',
          instructions: 'What is the customer mainly asking civitai.com support about?',
          options: TOPIC_OPTIONS,
        },
      ],
      mapAnswer: choiceMapper('topic', { abstainOptions: [CANNOT_TELL] }),
      trainTargets: choiceTargets('topic', { unknownClasses: [CANNOT_TELL] }),
    },
    router13: {
      questions: { fromDataDir: 'router13.questions.json' },
      mapAnswer: routerMapper('topic'),
    },
  },
  buildState: buildSupportState,
  slices: (raw) => ({
    period: periodOf(raw),
    stratum: raw.stratum ?? 'dev',
    lang: raw.lang || 'unknown',
  }),
  baselines: (raw) => ({
    incumbent: INCUMBENT_TOPIC_MAP[raw.incumbentTopic] ?? null,
    keyword: keywordBaseline(raw),
  }),
  source: supportSource,
  gold: supportGold,
  goldPolicy: (ctx): GoldPolicy => {
    const labeler = readConfig(ctx).primaryLabeler;
    if (!labeler) throw new Error('support.topic config.json needs primaryLabeler before scoring');
    return { kind: 'primary', labeler };
  },
};
