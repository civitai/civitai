import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';
import type * as MirrorService from '~/server/services/feature-pages/mirror.service';

// The Feature Pages discussion tests' shared ground: real Postgres (PGlite) as dbWrite and the
// Kysely client, and the data.civitai.com platform faked at fetch. Each test file mocks
// ~/server/db/kyselyDb to `holder.kysely` and the Flipt client to `flags`.

export const HUB = 'https://hub.test';
export const SIGNER = 'http://signer.internal';
export const SUBJECT = 'urn:data.civitai.com:feature-pages/requests/dark-mode';
export const UNKNOWN = 'urn:data.civitai.com:feature-pages/requests/no-such-request';
export const FEATURE = 'urn:data.civitai.com:feature-pages/features/dark-mode';
export const AUTHOR = 2;
export const OTHER = 3;

export const pg = { db: null as unknown as PGlite };
/**
 * One connection: a statement outside an open transaction waits for it, since a second connection
 * would not see the transaction's uncommitted rows anyway.
 */
const gate = { turn: Promise.resolve() as Promise<unknown> };
const raw = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pg.db.query<T>(text, params)).rows;
export const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
  await gate.turn;
  return raw<T>(text, params);
};

export const dialect = (db: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      await gate.turn;
      const result = await db.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

export const SETUP = `
ALTER TABLE "User" ADD COLUMN username text, ADD COLUMN "bannedAt" timestamp,
  ADD COLUMN "deletedAt" timestamp, ADD COLUMN muted boolean NOT NULL DEFAULT false;
INSERT INTO "User"(id) SELECT g FROM generate_series(1, 4) g ON CONFLICT DO NOTHING;
UPDATE "User" SET username = CASE id WHEN 2 THEN 'author' WHEN 3 THEN 'other' ELSE 'u' || id END;
-- The report enums as text domains: the casts the app writes resolve, and the text columns compare.
CREATE DOMAIN "ReportStatus" AS text;
CREATE DOMAIN "ReportReason" AS text;
ALTER TABLE "Report" ADD COLUMN status text NOT NULL DEFAULT 'Pending', ADD COLUMN reason text;
CREATE TABLE "EntityModeration"(id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
  status text NOT NULL DEFAULT 'Pending', "triggeredLabels" text[] NOT NULL DEFAULT '{}',
  result jsonb, "contentHash" text, UNIQUE ("entityType", "entityId"));
CREATE TABLE "TextScanHold"(id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
  label text NOT NULL, status text NOT NULL DEFAULT 'Pending', "textHash" text, meta jsonb, text text,
  "userId" int, reason text, "workflowId" text, "promptId" int, "contentAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now());
CREATE TABLE "TextScanPrompt"(id serial PRIMARY KEY, key text NOT NULL, content text NOT NULL);
INSERT INTO "TextScanPrompt"(key, content) VALUES ('base', 'Judge the text.'), ('label:scam', 'Is it a scam?');
`;

/** The platform's Comments write path, held in memory. */
export const platform = {
  down: false,
  unknown: new Set<string>(),
  /** Feature subjects the platform holds; any other features/ subject is unknown to it. */
  features: new Set<string>(),
  removed: new Set<number>(),
  /** Authors erased on the platform: every comment call for them answers 409 erased. */
  erasedUids: new Set<number>(),
  posts: [] as Record<string, unknown>[],
  verdicts: [] as { path: string; body: Record<string, any> }[],
  erased: [] as number[],
  keys: new Map<string, { hash: string; reply: unknown }>(),
  versions: new Map<number, number>(),
  /** Per comment: the newest `at` applied, and the site verdict each token was posted with. */
  lastAt: new Map<number, string>(),
  tokenSite: new Map<string, string>(),
  readback: null as null | ((items: unknown[], url: URL) => unknown[]),
  /** Called as a post is received, before it is applied: to land a change mid-send. */
  onPost: null as null | ((body: Record<string, any>) => Promise<void> | void),
  /** Drop the next reply after applying it, post or verdict (a lost response). */
  loseReply: false,
  /** Posts land held: the site verdict written is hidden, whatever the push asked for. */
  holdPosts: false,
  /** Failures the next comment posts meet, one each, in order. */
  failNext: [] as ('429' | '5xx' | 'timeout' | 'bad' | 'stale')[],
  /** Per comment: what its current version carries, to answer a push that changes nothing. */
  held: new Map<number, string>(),
  /** The by-source read answers 200 with a body that is not a record. */
  badBySource: false,
  /** The subject lookup answers with no route (a deploy gap) or a 200 that is not an answer. */
  subjectLookup: null as null | 'no-route' | 'bad',
};
export const urnOf = (sourceId: number) =>
  `urn:data.civitai.com:feature-pages/comments/c${sourceId}`;
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenOf = (sourceId: number) => `sha256:${sourceId}:${platform.versions.get(sourceId) ?? 0}`;
const sourceOfUrn = (urn: string) => Number(String(urn).split('/comments/c').pop());

/** A pipeline verdict on the comment's current token, as the moderation pipeline would write. */
export function pipelineVerdict(sourceId: number, verdict: 'visible' | 'hidden') {
  platform.verdicts.push({
    path: '/internal/verdict',
    body: {
      target: { urn: urnOf(sourceId), digest: tokenOf(sourceId) },
      verdict,
      at: new Date().toISOString(),
    },
  });
}

/** A verdict on the comment's current token, as `path`'s source wrote it at `at`. */
export function verdictAt(
  path: 'site' | 'mod',
  sourceId: number,
  verdict: 'visible' | 'hidden',
  at: Date
) {
  platform.verdicts.push({
    path: `/internal/verdict/${path}`,
    body: {
      target: { urn: urnOf(sourceId), digest: tokenOf(sourceId) },
      verdict,
      at: at.toISOString(),
    },
  });
}

/** What the platform shows for a comment: visible only when its deciding verdict is visible. */
export function decided(sourceId: number): 'visible' | 'hidden' {
  return deciding(sourceId)?.verdict === 'visible' ? 'visible' : 'hidden';
}

export type VerdictStep = {
  source: 'site' | 'pipeline' | 'moderator';
  outcome: string;
  /** Whether it was written on the comment's current token. */
  token: 'current' | 'old';
  at: string;
};

/**
 * The platform's decider over a comment's verdicts, in the order written. A write supersedes the
 * newest of its source not newer than itself, and within a source a tie goes to the non-visible
 * (platform wire contract 6.5). A moderator removal is final; otherwise the newest live moderator
 * hide hides, and a live moderator visible on the current token newer than it shows. Else
 * pipeline, then site, by their newest live verdict on the current token, failing closed: a hide
 * of either, or a newer hide on an old token, hides. None on the current token: none decides.
 */
export function decideVerdicts(steps: VerdictStep[]): { source: string; verdict: string } | null {
  const step = decidingStep(steps);
  return step && { source: step.source, verdict: step.verdict };
}

function decidingStep(
  steps: VerdictStep[]
): { source: string; verdict: string; at: string } | null {
  const removal = steps.find((s) => s.source === 'moderator' && s.outcome === 'removed');
  if (removal) return { source: 'moderator', verdict: 'removed', at: removal.at };
  const wins = (x: VerdictStep, over: VerdictStep) =>
    x.at > over.at || (x.at === over.at && x.outcome !== 'visible');
  const superseded = new Set<number>();
  steps.forEach((s, i) => {
    let prior = -1;
    steps.slice(0, i).forEach((p, j) => {
      if (p.source === s.source && wins(s, p) && (prior < 0 || p.at > steps[prior].at)) prior = j;
    });
    if (prior >= 0) superseded.add(prior);
  });
  const live = steps.filter((_, i) => !superseded.has(i));
  const newest = (xs: VerdictStep[]) =>
    xs.reduce<VerdictStep | undefined>((a, x) => (!a || wins(x, a) ? x : a), undefined);
  const mod = live.filter((s) => s.source === 'moderator');
  const lastMod = newest(mod);
  if (lastMod?.outcome === 'hidden')
    return { source: 'moderator', verdict: 'hidden', at: lastMod.at };
  const hiddenAt = newest(mod.filter((s) => s.outcome === 'hidden'))?.at ?? '';
  const modVisible = mod.find(
    (s) => s.outcome === 'visible' && s.token === 'current' && s.at > hiddenAt
  );
  if (modVisible) return { source: 'moderator', verdict: 'visible', at: modVisible.at };
  const of = (source: VerdictStep['source']) => {
    const current = newest(live.filter((s) => s.source === source && s.token === 'current'));
    if (!current) return undefined;
    const hiddenSince = live.find(
      (s) => s.source === source && s.token === 'old' && s.outcome === 'hidden' && s.at > current.at
    );
    return hiddenSince
      ? { source, verdict: 'hidden', at: hiddenSince.at }
      : { source, verdict: current.outcome, at: current.at };
  };
  const site = of('site');
  const pipeline = of('pipeline');
  if (pipeline?.verdict === 'hidden') return pipeline;
  if (site?.verdict === 'hidden') return site;
  return pipeline ?? site ?? null;
}

const SOURCE_OF_PATH: Record<string, VerdictStep['source']> = {
  '/internal/verdict': 'pipeline',
  '/internal/verdict/site': 'site',
  '/internal/verdict/mod': 'moderator',
};

/** The deciding verdict; null when none decides (withheld). */
export function deciding(sourceId: number): { source: string; verdict: string } | null {
  const step = decidingStepOf(sourceId);
  return step && { source: step.source, verdict: step.verdict };
}

/** The deciding verdict as the readback reports it, with its `at`. */
function decidingStepOf(sourceId: number) {
  const urn = urnOf(sourceId);
  const current = tokenOf(sourceId);
  const posted = platform.tokenSite.get(current);
  const steps: VerdictStep[] = [
    // A post writes its site verdict on the token it creates, before any later verdict.
    ...(posted
      ? [{ source: 'site' as const, outcome: posted, token: 'current' as const, at: '' }]
      : []),
    ...platform.verdicts
      .filter((v) => v.body.target.urn === urn)
      .map((v) => ({
        source: SOURCE_OF_PATH[v.path],
        outcome: String(v.body.verdict),
        token: v.body.target.digest === current ? ('current' as const) : ('old' as const),
        at: String(v.body.at ?? ''),
      })),
  ];
  return decidingStep(steps);
}

const subjectKnown = (urn: unknown) =>
  !platform.unknown.has(urn as string) &&
  (!String(urn).includes(':feature-pages/features/') || platform.features.has(urn as string));

export async function platformReply(url: URL, init: RequestInit): Promise<Response> {
  if (platform.down) return json(503, { code: 'unavailable' });
  const body = init.body ? JSON.parse(String(init.body)) : {};
  switch (url.pathname) {
    case '/internal/comment': {
      const failure = body.text !== null ? platform.failNext.shift() : undefined;
      if (failure === '429') return json(429, { code: 'rate_limited' });
      if (failure === '5xx') return json(502, { code: 'bad_gateway' });
      if (failure === 'bad') return json(200, { ok: true });
      if (failure === 'stale')
        return json(200, {
          ok: true,
          urn: urnOf(body.sourceId),
          digest: tokenOf(body.sourceId),
          stale: true,
        });
      if (!subjectKnown(body.subject)) return json(404, { code: 'unknown_subject' });
      if (/^\d*$/.test(String(body.authorName ?? '')))
        return json(400, { code: 'bad_request', message: 'authorName' });
      if (body.text !== null && !(body.text.length >= 1 && body.text.length <= 4000))
        return json(400, { code: 'bad_request', message: 'text' });
      if (platform.erasedUids.has(body.uid)) return json(409, { code: 'erased' });
      if (platform.removed.has(body.sourceId)) return json(409, { code: 'removed' });
      const { idempotencyKey, ...rest } = body;
      const hash = JSON.stringify(rest);
      // A retract carries no key: every one is applied.
      const seen = idempotencyKey ? platform.keys.get(idempotencyKey) : undefined;
      if (seen && seen.hash !== hash) return json(409, { code: 'idempotency_mismatch' });
      if (seen) return json(200, { ...(seen.reply as object), replayed: true });
      await platform.onPost?.(body);
      const last = platform.lastAt.get(body.sourceId);
      if (body.at && last && body.at < last)
        return json(200, {
          ok: true,
          urn: urnOf(body.sourceId),
          digest: tokenOf(body.sourceId),
          stale: true,
        });
      // The same text, masking and name with no newer time: nothing written, no verdict either.
      const content = JSON.stringify([body.text, body.maskedText, body.authorName]);
      const current = platform.held.get(body.sourceId);
      if (current === content && (!body.at || body.at === last)) {
        const reply = {
          ok: true,
          urn: urnOf(body.sourceId),
          digest: tokenOf(body.sourceId),
          unchanged: true,
        };
        if (idempotencyKey) platform.keys.set(idempotencyKey, { hash, reply });
        if (platform.loseReply) {
          platform.loseReply = false;
          return json(504, { code: 'gateway_timeout' });
        }
        return json(200, reply);
      }
      platform.held.set(body.sourceId, content);
      if (body.at) platform.lastAt.set(body.sourceId, body.at);
      platform.posts.push(body);
      const version = (platform.versions.get(body.sourceId) ?? 0) + 1;
      platform.versions.set(body.sourceId, version);
      const outcome = platform.holdPosts ? 'hidden' : body.siteVerdict;
      if (body.text !== null) platform.tokenSite.set(tokenOf(body.sourceId), outcome);
      const reply = {
        ok: true,
        urn: urnOf(body.sourceId),
        digest: tokenOf(body.sourceId),
        retracted: body.text === null,
        ...(body.text === null ? {} : { verdict: { urn: `v-${version}`, outcome } }),
      };
      if (idempotencyKey) platform.keys.set(idempotencyKey, { hash, reply });
      if (platform.loseReply) {
        platform.loseReply = false;
        return json(504, { code: 'gateway_timeout' });
      }
      return json(200, reply);
    }
    case '/internal/verdict/site':
    case '/internal/verdict/mod': {
      const bySource = body.target.sourceId !== undefined;
      if (bySource && url.pathname.endsWith('/site') && body.verdict !== 'hidden')
        return json(400, { code: 'bad_request', message: 'target' });
      const sourceId = bySource ? Number(body.target.sourceId) : sourceOfUrn(body.target.urn);
      if (platform.removed.has(sourceId)) return json(409, { code: 'removed' });
      const held = platform.posts.some((p) => p.sourceId === sourceId);
      if (bySource) {
        // Stored on the derived urn under a token that is no version's, so it waits for a post.
        platform.verdicts.push({
          path: url.pathname,
          body: { ...body, target: { urn: urnOf(sourceId), digest: `source:${sourceId}` } },
        });
        return json(200, { ok: true, held, ...(held ? {} : { preverdict: true }) });
      }
      if (url.pathname.endsWith('/site') && body.target.digest !== tokenOf(sourceId))
        return json(409, { code: 'stale_digest', details: { digest: tokenOf(sourceId) } });
      platform.verdicts.push({ path: url.pathname, body });
      if (platform.loseReply) {
        platform.loseReply = false;
        return json(504, { code: 'gateway_timeout' });
      }
      return json(200, { ok: true });
    }
    case '/internal/subject': {
      if (platform.subjectLookup === 'no-route') return json(404, { code: 'not_found' });
      if (platform.subjectLookup === 'bad') return json(200, { ok: true });
      const urn = url.searchParams.get('urn') ?? '';
      return subjectKnown(urn)
        ? json(200, {
            urn,
            known: true,
            kind: urn.includes(':feature-pages/features/') ? 'feature' : 'request',
          })
        : json(404, { code: 'unknown_subject' });
    }
    case '/internal/comments/by-source': {
      if (platform.badBySource) return json(200, { ok: true });
      const sourceId = Number(url.searchParams.get('sourceId'));
      const last = platform.posts.filter((p) => p.sourceId === sourceId).at(-1);
      if (!last) return json(404, { code: 'not_held' });
      const verdict = deciding(sourceId)?.verdict;
      const state = platform.removed.has(sourceId)
        ? 'removed'
        : platform.erasedUids.has(last.uid as number)
        ? 'erased'
        : last.text === null
        ? 'retracted'
        : verdict === 'visible'
        ? 'visible'
        : verdict
        ? 'hidden'
        : 'withheld';
      return json(200, { urn: urnOf(sourceId), digest: tokenOf(sourceId), state });
    }
    case '/internal/author/erase':
      platform.erased.push(body.uid);
      platform.erasedUids.add(body.uid);
      return json(200, { ok: true });
    case '/internal/comments': {
      const latest = new Map<string, unknown>();
      for (const p of platform.posts)
        latest.set(urnOf(p.sourceId as number), {
          urn: urnOf(p.sourceId as number),
          digest: tokenOf(p.sourceId as number),
          retracted: p.text === null || platform.erasedUids.has(p.uid as number),
          removed: platform.removed.has(p.sourceId as number) || undefined,
          verdict: decidingStepOf(p.sourceId as number),
        });
      // In key order from after the cursor, as the platform pages.
      const keyOf = (i: unknown) =>
        String((i as { urn: string }).urn)
          .split('/')
          .pop()!;
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? 0);
      let items = [...latest.values()];
      if (cursor !== null)
        items = items
          .filter((i) => keyOf(i) > cursor)
          .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
      if (limit) items = items.slice(0, limit);
      return json(200, {
        items: platform.readback ? platform.readback(items, url) : items,
        next: null,
      });
    }
  }
  return json(404, { code: 'not_found' });
}

export const fetchFake = vi.fn(async (input: string, init: RequestInit = {}) => {
  if (input === `${HUB}/api/auth/oauth/token`) return json(200, { access_token: 'token' });
  if (input.startsWith(SIGNER)) {
    if (
      platform.failNext[0] === 'timeout' &&
      input.endsWith('/internal/comment') &&
      JSON.parse(String(init.body)).text !== null
    ) {
      platform.failNext.shift();
      throw new TypeError('fetch failed');
    }
    return platformReply(new URL(input), init);
  }
  throw new Error(`unexpected fetch ${input}`);
});

export const posts = () => platform.posts.filter((p) => p.text !== null);
export const verdicts = (path: 'site' | 'mod') =>
  platform.verdicts
    .filter((v) => v.path === `/internal/verdict/${path}`)
    .map((v) => [v.body.verdict, v.body.reason ?? null]);

/** A database with the comment schema as it stands before this feature's migration. */
/** The CommentV3 migrations this feature's migration applies on top of, in order. */
export const COMMENT_V3_MIGRATIONS = [
  '20261110120000_comment_v3_schema',
  '20261120120000_comment_v3_mirror',
  '20261210120000_comment_v3_mirror_changed_columns',
  '20270101120000_comment_v3_old_table_triggers_off',
  '20270102120000_comment_v3_teardown',
  '20271125130000_comment_v3_hidden_at',
];

export async function commentSchemaDatabase() {
  const db = new PGlite({ extensions: { ltree } });
  await db.exec(FIXTURE);
  await db.exec(SETUP);
  for (const name of COMMENT_V3_MIGRATIONS) await db.exec(migration(name));
  return db;
}

/** Boots the database with the comment schema and this feature's migration (twice, as a re-run). */
export async function bootFpDatabase(holder: { kysely: unknown }) {
  pg.db = await commentSchemaDatabase();
  // As it is applied by hand: the enum value on its own, then the rest. Twice, as a re-run would.
  for (let i = 0; i < 2; i++) {
    const [value, rest] = migration('20271125140000_feature_page_comments').split('\n-- 2.');
    await pg.db.exec(value);
    await pg.db.exec(`-- 2.${rest}`);
    await pg.db.exec(migration('20271129120000_feature_page_mirror_lift'));
  }
  holder.kysely = new Kysely({ dialect: dialect(pg.db) });
  vi.stubEnv('AUTH_JWT_ISSUER', HUB);
}

/** Per test: the signer env, a fresh platform, dbWrite over PGlite, and empty feature tables. */
export async function resetFpState(flags: { mirror: boolean }) {
  vi.stubEnv('AUTH_JWT_ISSUER', HUB);
  envMock.set({
    FEATURE_PAGES_SIGNER_URL: SIGNER,
    FEATURE_PAGES_CLIENT_ID: 'client-id',
    FEATURE_PAGES_CLIENT_SECRET: 'client-secret',
  });
  installFakeCacheRedis();
  vi.stubGlobal('fetch', fetchFake);
  fetchFake.mockClear();
  flags.mirror = true;
  Object.assign(platform, {
    down: false,
    unknown: new Set([UNKNOWN]),
    features: new Set(),
    removed: new Set(),
    erasedUids: new Set(),
    posts: [],
    verdicts: [],
    erased: [],
    keys: new Map(),
    versions: new Map(),
    lastAt: new Map(),
    tokenSite: new Map(),
    readback: null,
    onPost: null,
    loseReply: false,
    holdPosts: false,
    failNext: [],
    held: new Map(),
    badBySource: false,
    subjectLookup: null,
  });
  // The text-scan rollout: CommentV3 fully active.
  redisMock.sysRedis.hGetAll.mockImplementation((async () => ({
    CommentV3: '{"shadow":100,"active":100}',
  })) as never);

  // dbWrite over PGlite: raw SQL, tagged SQL, and transactions. One connection, so transactions
  // take turns, as two writers on one row would.
  const runner = (exec: typeof raw) => ({
    unsafe: async (text: string, ...params: unknown[]) => exec(text, params),
    tagged: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const s = Prisma.sql(strings, ...values);
      return exec(s.text, s.values);
    },
  });
  const outside = runner(q);
  const inside = runner(raw);
  dbMock.dbWrite.$queryRawUnsafe.mockImplementation(outside.unsafe as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(outside.tagged as never);
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) => {
    const run = gate.turn.then(async () => {
      await pg.db.exec('BEGIN');
      try {
        // Raw SQL runs in the transaction; a model call (tx.textScanHold…) falls to dbMock.
        const tx = {
          $queryRawUnsafe: inside.unsafe,
          $queryRaw: inside.tagged,
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const s = Prisma.sql(strings, ...values);
            return (await pg.db.query(s.text, s.values)).affectedRows ?? 0;
          },
        };
        const out = await fn(
          new Proxy(tx, {
            get: (target, key) =>
              key in target
                ? target[key as keyof typeof target]
                : (dbMock.dbWrite as unknown as Record<PropertyKey, unknown>)[key],
          })
        );
        await pg.db.exec('COMMIT');
        return out;
      } catch (e) {
        await pg.db.exec('ROLLBACK');
        throw e;
      }
    });
    gate.turn = run.catch(() => undefined);
    return run;
  }) as never);
  await pg.db.exec(`
    DELETE FROM "FeaturePageCommentMirror"; DELETE FROM "CommentV3Report"; DELETE FROM "Report";
    DELETE FROM "EntityModeration"; DELETE FROM "TextScanHold";
    DELETE FROM "CommentV3" WHERE "entityType"::text = 'featurePage';
    DELETE FROM "CommentTopic" WHERE "entityType"::text = 'featurePage';
    DELETE FROM "FeaturePageTopic";
    UPDATE "User" SET "deletedAt" = NULL, "bannedAt" = NULL, muted = false,
      username = CASE id WHEN 2 THEN 'author' WHEN 3 THEN 'other' ELSE 'u' || id END;`);
}

export const mirrorRow = async (commentId: number) =>
  (
    await q<Record<string, any>>(
      `SELECT * FROM "FeaturePageCommentMirror" WHERE "commentId" = $1`,
      [commentId]
    )
  )[0];

/** The cron, with every scheduled row made due. */
export const runMirror = async (mirror: typeof MirrorService) => {
  await q(
    `UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "nextPushAt" IS NOT NULL`
  );
  return mirror.runFpMirror();
};

let seeded = 0;
/** A finished scan of the comment's current text that found nothing. */
export async function scanClean(id: number) {
  const { currentScanContentHashes } = await import('~/server/services/text-scan/submit');
  const hash = (await currentScanContentHashes('CommentV3', [id])).get(id) ?? null;
  await q(
    `INSERT INTO "EntityModeration"("entityType", "entityId", status, "contentHash")
     VALUES ('CommentV3', $1, 'Succeeded', $2)
     ON CONFLICT ("entityType", "entityId") DO UPDATE
       SET status = 'Succeeded', "contentHash" = EXCLUDED."contentHash", "triggeredLabels" = '{}'`,
    [id, hash]
  );
}

/**
 * A Feature Pages comment as the post path leaves it: topic, comment and mirror row, then the one
 * inline push. A clean scan of its text is recorded first unless `scanned: false`. For the
 * mirror's own tests, which must not depend on the post path.
 */
export async function seedFpComment(
  mirror: typeof MirrorService,
  text: string,
  {
    userId = AUTHOR,
    subject = SUBJECT,
    scanned = true,
  }: { userId?: number; subject?: string; scanned?: boolean } = {}
) {
  const [{ id: topicId }] = await q<{ id: number }>(
    `INSERT INTO "FeaturePageTopic" (urn, kind) VALUES ($1, 'request')
     ON CONFLICT (urn) DO UPDATE SET urn = EXCLUDED.urn RETURNING id`,
    [subject]
  );
  await q(
    `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('featurePage', $1) ON CONFLICT DO NOTHING`,
    [topicId]
  );
  const [{ id }] = await q<{ id: number }>(
    `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content)
     VALUES ('featurePage', $1, $2, $3) RETURNING id`,
    [topicId, userId, `<p>${text}</p>`]
  );
  const requestId = `seed-${++seeded}`;
  await q(
    `INSERT INTO "FeaturePageCommentMirror"("commentId", "userId", "requestId", "nextPushAt")
     VALUES ($1, $2, $3, now() + interval '60 seconds')`,
    [id, userId, requestId]
  );
  if (scanned) await scanClean(id);
  await mirror.pushNewFpComment(id);
  return { comment: { sourceId: id, urn: (await mirrorRow(id)).urn as string | null } };
}
