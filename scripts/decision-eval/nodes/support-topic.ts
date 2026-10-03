import { createClient } from '@clickhouse/client';
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { GoldPolicy } from '../builder';
import type { NodeContext, NodeSpec, SourceRow } from '../nodes';
import { choiceMapper } from '../runner';
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

/** Removes the requester's own identifiers, then anything email-, link- or handle-shaped. */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const k of known) {
    if (k.trim().length >= 3) out = out.replace(new RegExp(escapeRegExp(k.trim()), 'gi'), '[user]');
  }
  return out
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/gi, '[link]')
    .replace(/(^|[^\w@])@[A-Za-z0-9_]{2,}/g, '$1[handle]');
}

export function buildSupportState(raw: SupportTicketRaw): DecisionState {
  const known = [raw.requesterEmail, raw.requesterEmail.split('@')[0] ?? '', raw.username];
  return {
    subject: redact(raw.subject, known),
    first_message: redact(raw.firstMessage.slice(0, FIRST_MESSAGE_CHARS), known),
    latest_messages: redact(raw.latestMessages.slice(-LATEST_MESSAGES_CHARS), known),
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

export function goldFromLabel(labelTopic: string, notes: string): string | null {
  if (!labelTopic) return notes.startsWith(CANNOT_TELL_NOTES_PREFIX) ? CANNOT_TELL : null;
  return INCUMBENT_TOPIC_MAP[labelTopic] ?? null;
}

export function periodOf(raw: SupportTicketRaw): string {
  return raw.stratum ? raw.createdAt.slice(0, 7) : 'dev';
}

/** One row per ticket in the label sampler's strata sidecar. */
export function parseStrataCsv(text: string): Map<string, string> {
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = header.split(',');
  const idCol = cols.indexOf('ticket_id');
  const stratumCol = cols.indexOf('stratum');
  if (idCol < 0 || stratumCol < 0)
    throw new Error('strata file needs ticket_id and stratum columns');
  return new Map(
    lines.map((l) => {
      const cells = l.split(',');
      return [cells[idCol], cells[stratumCol]];
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
  /** Whose label is gold when the double-labelled tickets disagree; the other feeds the human baseline. */
  primaryLabeler?: string;
};

function nodeDir(ctx: NodeContext): string {
  return join(ctx.dataDir, NODE_ID);
}

function readConfig(ctx: NodeContext): SupportTopicConfig {
  const path = join(nodeDir(ctx), 'config.json');
  if (!existsSync(path)) throw new Error(`${path} is missing; see the support-topic node header`);
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<SupportTopicConfig>;
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

export const HUMAN_LABELS_SQL = `
  SELECT ticket_id, label_topic, notes, labeler
  FROM support_ticket_eval_labels FINAL
  WHERE classifier_version = {cv:String} AND labeler NOT LIKE 'judge-%'`;

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
  ticket_created_at: string;
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
  SELECT ticket_id, ticket_created_at, ticket_subject, body_clean, conversation_tail,
         member_tier, lang, topic, requester_freshdesk_id, requester_email, civitai_username
  FROM support_tickets_classified FINAL
  WHERE classifier_version = {cv:String} AND ticket_id IN {ids:Array(String)}`;

async function* supportSource(ctx: NodeContext): AsyncIterable<SourceRow<SupportTicketRaw>> {
  const cfg = readConfig(ctx);
  const salt = groupSalt(ctx);
  const stratumOf = new Map<string, string>();
  for (const file of cfg.testStrataFiles) {
    for (const [id, s] of parseStrataCsv(readFileSync(join(nodeDir(ctx), file), 'utf8'))) {
      stratumOf.set(id, s);
    }
  }
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
  const missing = stratumOf.size + devIds.size - rows.length;
  if (missing !== 0) {
    throw new Error(
      `expected one stored row per ticket, got ${rows.length} for ${
        stratumOf.size + devIds.size
      } ids`
    );
  }
  const out = rows.map((r): SourceRow<SupportTicketRaw> => {
    const createdAt = new Date(`${r.ticket_created_at.replace(' ', 'T')}Z`).toISOString();
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
  const { kept, dropped } = dropDevSharingTestGroup(out);
  if (dropped)
    console.error(`support.topic: ${dropped} dev item(s) dropped: their requester is in test`);
  yield* kept;
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
  for (const l of await humanLabels(readConfig(ctx))) {
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
    return labeler ? { kind: 'primary', labeler } : { kind: 'majority' };
  },
};
