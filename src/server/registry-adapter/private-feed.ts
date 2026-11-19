/**
 * AUTHORIZED PRIVATE STREAMS: one user's private documents of one collection, streamed on the
 * collection's own schema URN (`urn:schema:apps.civitai.com:<slug>/<coll>@vN`) to an authorized
 * subscription that may read them, and to nobody else. The auth extension's origin rule 4: "An
 * origin holding restricted data streams, to each authorized subscription, what that token may
 * read, by its own grants. A grant that ends removes the entity from that stream as a `Delete`."
 *
 * SWITCHED OFF BY DEFAULT. Nothing here is built unless `REGISTRY_ADAPTER_PRIVATE_RELAYS` names at
 * least one relay (`main.ts`, {@link parsePrivateRelays}); unset or empty, every document stream is
 * the public feed's (`doc-feed.ts`), exactly as before.
 *
 * Which collections: those whose approved app declares them `visibility: "private"` (each user has
 * their own key space). A subscription to such a collection's schema is routed here
 * ({@link createPrivateDocFeed} `routes`), whoever sends it; what it is then sent depends on the
 * gates below. A public collection never reaches this feed, and this feed never reads a shared
 * document (`createDocStorePrivateFeed` in `doc-store.ts` reads one user's key space only).
 *
 * THE GATES, in order. Every one must pass for a single record to be sent; a refusal streams
 * NOTHING (an empty snapshot and `live`, as for a collection not published), so a refused
 * subscriber learns nothing, not even whether the user holds anything:
 *   1. the subscription carries a token (anonymous: nothing);
 *   2. the token is a USER's (`VerifiedToken.userId`): a service's own token, which has no user,
 *      never reads private data;
 *   3. the relay that presents it (`act.sub`) is one of {@link PrivateFeedOptions.relays}: a
 *      token with no actor (sent directly, not exchanged by a relay) or from any other relay reads
 *      nothing;
 *   4. the token grants `AppDataRead`;
 *   5. the one collection-read predicate (`decideCollectionRead`, `data-read-grant.ts`, injected
 *      as {@link PrivateFeedOptions.decide}) grants this user, through this token's client, this
 *      collection: the client is the app itself (`own`), or an app the user granted the import
 *      (`grant`). Every record sent is the user's own (their key space), so the collection's
 *      decision is each record's. Its mature-content ceiling is the subscription's audience.
 * Gates 1–4 depend only on the token, which is fixed for the stream's life. Gate 5 is re-run on
 * EVERY poll.
 *
 * REVOCATION. Each poll ({@link PrivateFeedOptions.pollMs}, `REGISTRY_ADAPTER_POLL_SECONDS`,
 * default 60 s) re-runs gate 5 and re-reads the user's records. A grant revoked, the import scope
 * withdrawn, the app no longer approved, the user no longer allowed to run apps, the source
 * re-rated above the audience: the stream then holds nothing, and every record it had sent goes as
 * a `Delete`. A record deleted or hidden goes as a `Delete` the same way. So the lag is at most one
 * poll interval plus that poll's reads (and the read replica's lag on the app rows). A failed read
 * is never taken for a revocation: it ends the stream `unavailable`, and the consumer resumes.
 * A resume is judged the same way: a cursor whose gates 1–4 still pass resumes, and its first poll
 * sends the `Delete`s for whatever the user lost while the consumer was away.
 *
 * CURSORS. A cursor names a stored state (`p1.<digest>`) that records the token's SUBJECT (user and
 * client), the audience, the app, the schemas and every (urn, rev) sent. A cursor is refused
 * (`cursor_expired`) before its state is used when the token fails gates 1–4, when it was issued to
 * another subject (the auth extension's relay rule 3, enforced here too, since the request binding
 * in `subscription.ts` is a public digest) or another audience, or when it is older than
 * {@link PRIVATE_CURSOR_TTL_MS} (7 days). Private states are kept apart from public ones, under a
 * retention of {@link PRIVATE_STATE_RETENTION_SECONDS}.
 *
 * A private record's URN is `urn:apps.civitai.com:<slug>/<coll>/<record_id>`, the record core's
 * (`app-record.ts`): its stored random id, since a private key is unique only within one user's
 * key space. A row with no `record_id` yet is not sent.
 *
 * Relays never share or cache an authorized stream (auth extension, relay rule 2); over HTTP every
 * authorized stream is also sent `Cache-Control: private, no-store` (`serve.ts`).
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceAdmits, contextAudience } from '~/server/registry-adapter/audience';
import { hasScope } from '~/server/registry-adapter/auth.jwt';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import { createClaimer, docRev, familyDigest } from '~/server/registry-adapter/doc-feed';
import type { AdapterContext, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';
import { registryUrn } from '~/server/registry-adapter/urn';
import type {
  CollectionReadDecision,
  CollectionReadTarget,
  DataReader,
} from '~/server/services/apps/data-read-grant';
import type { PrivateFeedDocument, PrivateFeedVersion } from '~/server/services/apps/doc-store';

/** How long a private stream's cursor may be resumed from after it was issued. */
export const PRIVATE_CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a private stream's state is kept in the snapshot store: the cursor's lifetime. */
export const PRIVATE_STATE_RETENTION_SECONDS = PRIVATE_CURSOR_TTL_MS / 1000;

/**
 * The relays allowed to read private data (`REGISTRY_ADAPTER_PRIVATE_RELAYS`): the OAuth client
 * ids a relay exchanges tokens as (a token's `act.sub`), separated by commas or whitespace. Unset
 * or empty is the empty set: no private stream exists.
 */
export function parsePrivateRelays(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(/[\s,]+/).filter(Boolean));
}

/** Why gates 1–4 refuse a subscription; null when they pass. */
export type PrivateGateRefusal = 'anonymous' | 'not_user' | 'relay_not_listed' | 'scope_missing';

/** Gates 1–4 (see the file comment), in order: what depends only on the token. */
export function privateTokenGate(
  relays: ReadonlySet<string>,
  reader: AdapterContext['reader']
): PrivateGateRefusal | null {
  if (!reader) return 'anonymous';
  if (reader.userId === null) return 'not_user';
  if (reader.actor === null || !relays.has(reader.actor)) return 'relay_not_listed';
  if (!hasScope(reader, 'AppDataRead')) return 'scope_missing';
  return null;
}

/** The private reads of the document store (`createDocStorePrivateFeed`). */
export type PrivateDocSource = {
  versions(
    appId: string,
    coll: string,
    userId: number,
    afterKey: string,
    limit: number
  ): Promise<PrivateFeedVersion[]>;
  documents(
    appId: string,
    coll: string,
    userId: number,
    afterKey: string,
    limit: number
  ): Promise<PrivateFeedDocument[]>;
};

/** A private collection major that resolves now: its app (by the catalog) and its family. */
export type PrivateCollectionStream = Pick<
  CollectionStream,
  'appId' | 'slug' | 'collection' | 'family'
>;

/**
 * The private collection a stream schema names, by the catalog: the approved app declares the
 * collection `private` and the major is minted. Null otherwise. It decides no access.
 */
export type ResolvePrivateStream = (schema: string) => Promise<PrivateCollectionStream | null>;

/** The collection-read predicate, `decideCollectionRead` (`data-read-grant.ts`). */
export type DecideCollectionRead = (
  reader: DataReader,
  target: CollectionReadTarget
) => Promise<CollectionReadDecision>;

export type PrivateFeedOptions = {
  /** {@link parsePrivateRelays}; empty serves nothing to anyone. */
  relays: ReadonlySet<string>;
  source: PrivateDocSource;
  resolve: ResolvePrivateStream;
  decide: DecideCollectionRead;
  /** A store of its own: private states are never kept beside public ones. */
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
  now?: () => number;
};

export const PRIVATE_PAGE = 500;
const STATE_FORMAT = 'p1';
/** The cursor of a private stream that holds nothing; it names no stored state. */
export const PRIVATE_EMPTY_CURSOR = `${STATE_FORMAT}.empty`;
const CURSOR_RE = /^p1\.([0-9a-f]{32})$/;

type PrivateState = {
  v: typeof STATE_FORMAT;
  schema: string;
  /** The token subject (user and client) this state was served to; null only when empty. */
  subject: string | null;
  audience: string;
  appId: string | null;
  family: string | null;
  /** A digest of every (record id, version) read, sent or not: what an unchanged poll compares. */
  read: string | null;
  /** When the state was saved, ms: its cursor expires {@link PRIVATE_CURSOR_TTL_MS} after. */
  issuedAt: number;
  served: Array<[urn: string, rev: string]>;
};

type Reader = NonNullable<AdapterContext['reader']>;

export function createPrivateDocFeed(opts: PrivateFeedOptions) {
  const claimer = createClaimer();
  const now = opts.now ?? Date.now;

  const emptyState = (schema: string, audience: Audience): PrivateState => ({
    v: STATE_FORMAT,
    schema,
    subject: null,
    audience: audience.key,
    appId: null,
    family: null,
    read: null,
    issuedAt: 0,
    served: [],
  });

  const save = async (state: PrivateState): Promise<string> => {
    if (state.appId === null && state.served.length === 0) return PRIVATE_EMPTY_CURSOR;
    const stamped = { ...state, issuedAt: now() };
    const raw = sortedKeyJson(stamped);
    const digest = sha256Hex(raw).slice(0, 32);
    await opts.store.put(digest, raw, `${state.schema}#${state.subject}#${state.audience}`);
    return `${STATE_FORMAT}.${digest}`;
  };

  /** The state a cursor names, every check passed before any of it is used. */
  const load = async (
    schema: string,
    cursor: string,
    reader: AdapterContext['reader'],
    audience: Audience
  ): Promise<PrivateState> => {
    if (cursor === PRIVATE_EMPTY_CURSOR) return emptyState(schema, audience);
    const digest = CURSOR_RE.exec(cursor)?.[1];
    if (!digest) throw cursorExpired('not a cursor this source issued');
    // Before the store is read: a token that may read no private stream resumes none.
    if (privateTokenGate(opts.relays, reader) !== null) {
      throw cursorExpired('this token cannot resume a private stream');
    }
    const raw = await opts.store.get(digest);
    if (raw === null) throw cursorExpired('the state this cursor names is no longer held');
    let state: PrivateState;
    try {
      state = JSON.parse(raw) as PrivateState;
    } catch {
      throw cursorExpired('the state this cursor names is unreadable');
    }
    if (state.v !== STATE_FORMAT || state.schema !== schema) {
      throw cursorExpired('the cursor belongs to another stream');
    }
    if (state.subject !== reader?.subject) {
      throw cursorExpired('the cursor was issued to another token subject');
    }
    if (state.audience !== audience.key) {
      throw cursorExpired('the cursor was issued to a token that may read different ratings');
    }
    if (!(now() - state.issuedAt <= PRIVATE_CURSOR_TTL_MS)) {
      throw cursorExpired('the cursor is older than a private stream keeps');
    }
    await opts.store.touch(digest, `${state.schema}#${state.subject}#${state.audience}`);
    return state;
  };

  async function readPaged<T extends { key: string }>(
    page: (afterKey: string) => Promise<T[]>
  ): Promise<T[]> {
    const out: T[] = [];
    let after = '';
    for (;;) {
      const rows = await page(after);
      out.push(...rows);
      if (rows.length < PRIVATE_PAGE) return out;
      after = rows[rows.length - 1].key;
    }
  }

  /**
   * The stream's state now, for this reader, from `prev` (null for a snapshot), and the entities to
   * upsert. Any refusal is a stream that holds nothing: what it had sent leaves as deletes.
   */
  async function advance(
    schema: string,
    prev: PrivateState | null,
    reader: AdapterContext['reader'],
    audience: Audience
  ): Promise<{ next: PrivateState; entities: Map<string, Entity> }> {
    const nothing = () => ({ next: emptyState(schema, audience), entities: new Map() });
    if (privateTokenGate(opts.relays, reader) !== null) return nothing();
    const { subject, userId, clientId } = reader as Reader & { userId: number };
    const stream = await opts.resolve(schema);
    if (!stream) return nothing();
    const { appId, slug, collection, family } = stream;
    const decision = await opts.decide(
      { userId, clientId, matureAllowed: (rating) => audienceAdmits(audience, rating) },
      { sourceBlockId: slug, collection }
    );
    if (!decision.ok) return nothing();
    // The predicate read the app's row itself: it must be the app the catalog named, and still
    // declare the collection private.
    if (decision.source.id !== appId) return nothing();
    if (decision.source.collections.get(collection)?.visibility !== 'private') return nothing();
    if (prev?.appId && prev.appId !== appId) {
      throw cursorExpired('the collection now belongs to a different app');
    }

    const digest = familyDigest(family);
    const versions = await readPaged((after) =>
      opts.source.versions(appId, collection, userId, after, PRIVATE_PAGE)
    );
    const read = sha256Hex(
      sortedKeyJson(versions.map((v) => [v.recordId, v.version]).sort())
    ).slice(0, 32);
    if (prev && prev.appId === appId && prev.family === digest && prev.read === read) {
      return { next: prev, entities: new Map() };
    }

    const claims = claimer(family, digest);
    const entities = new Map<string, Entity>();
    const docs = await readPaged((after) =>
      opts.source.documents(appId, collection, userId, after, PRIVATE_PAGE)
    );
    for (const d of docs) {
      const schemas = claims(d.data);
      if (!schemas.includes(schema)) continue;
      const urn = registryUrn({ kind: 'document', slug, collection, key: d.recordId });
      entities.set(urn, { urn, schemas, rev: docRev(d, schemas), body: d.data });
    }
    return {
      next: {
        v: STATE_FORMAT,
        schema,
        subject,
        audience: audience.key,
        appId,
        family: digest,
        read,
        issuedAt: 0,
        served: [...entities.values()]
          .map((e) => [e.urn, e.rev] as [string, string])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      },
      entities,
    };
  }

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      opts.onError?.(err);
      throw new ProtocolError('unavailable', 'the private document feed could not be read');
    }
  };

  async function* follow(
    schema: string,
    cursor: string,
    loaded: PrivateState,
    first: Awaited<ReturnType<typeof advance>>,
    ctx: AdapterContext,
    audience: Audience
  ): AsyncGenerator<Change> {
    let state = loaded;
    let position = cursor;
    let pending: Awaited<ReturnType<typeof advance>> | null = first;
    while (!ctx.signal.aborted) {
      const before = state;
      const { next, entities } =
        pending ?? (await guarded(() => advance(schema, before, ctx.reader, audience)));
      pending = null;
      if (next !== before) {
        const was = new Map(before.served);
        const still = new Set(next.served.map(([urn]) => urn));
        const deletes = [...was.keys()].filter((urn) => !still.has(urn)).sort();
        const upserts = next.served
          .filter(([urn, rev]) => was.get(urn) !== rev)
          .map(([urn]) => entities.get(urn))
          .filter((e): e is Entity => e !== undefined);
        const diff: Array<{ delete: string } | { upsert: Entity }> = [
          ...deletes.map((urn) => ({ delete: urn })),
          ...upserts.map((upsert) => ({ upsert })),
        ];
        state = next;
        if (diff.length > 0) {
          const nextCursor = await guarded(() => save(next));
          for (let i = 0; i < diff.length; i++) {
            if (ctx.signal.aborted) return;
            const at = i === diff.length - 1 ? nextCursor : position;
            const c = diff[i];
            yield 'upsert' in c
              ? { upsert: c.upsert, cursor: at }
              : { delete: c.delete, cursor: at };
          }
          position = nextCursor;
        }
      }
      await opts.sleep(opts.pollMs, ctx.signal);
    }
  }

  return {
    /**
     * Whether a document stream's schema is served here: a collection its approved app declares
     * private. Decides no access: a subscription routed here may still be sent nothing.
     */
    async routes(schema: string): Promise<boolean> {
      return (await guarded(() => opts.resolve(schema))) !== null;
    },

    /** Whether a cursor is one this feed issued, so its resume is answered here. */
    issued(cursor: string): boolean {
      return cursor === PRIVATE_EMPTY_CURSOR || CURSOR_RE.test(cursor);
    },

    async snapshot(schema: string, ctx: AdapterContext) {
      const audience = contextAudience(ctx);
      const { next, entities } = await guarded(() => advance(schema, null, ctx.reader, audience));
      const cursor = await guarded(() => save(next));
      return { cursor, entities: [...entities.values()] };
    },

    async changes(schema: string, cursor: string, ctx: AdapterContext) {
      const audience = contextAudience(ctx);
      const state = await guarded(() => load(schema, cursor, ctx.reader, audience));
      const first = await guarded(() => advance(schema, state, ctx.reader, audience));
      return follow(schema, cursor, state, first, ctx, audience);
    },
  };
}
