/**
 * AUTHORIZED PRIVATE STREAMS: one user's private documents of one collection, on the collection's
 * own schema URN, to a subscription that may read them (the auth extension's origin rule 4).
 *
 * OFF unless `REGISTRY_ADAPTER_PRIVATE_RELAYS` names a relay ({@link parsePrivateRelays}); until
 * then every document stream is the public feed's.
 *
 * THE GATES, in order; a refusal streams NOTHING (an empty snapshot and `live`), so a refused
 * subscriber learns nothing, not even whether the user holds any records:
 *   1. a token; 2. a user's token (`VerifiedToken.userId`, never a service's);
 *   3. presented by a listed relay (`act.sub`); 4. granting `AppDataRead`;
 *   5. `decideCollectionRead` grants this user, through this client, this collection.
 * Gates 1–4 are fixed for the token's life; gate 5 re-runs on every poll, which is what turns a
 * revocation into `Delete`s within one {@link PrivateFeedOptions.pollMs}.
 *
 * A BLOCK-EXCHANGE TOKEN (`VerifiedToken.block`: the hub minted it from an App Block token, and it
 * carries that token's block, install and ceiling; `auth.jwt.ts`) is held, on every poll, to what
 * the site's document store would serve the block token itself:
 *   - its ceiling: a source app whose rating the viewer's audience admits is read only when
 *     `ratingAllowedForCeiling` (`rating-ceiling.ts`) also admits it for the token's
 *     `civitai_max_browsing_level`. That is the store's own rule for a block token's import
 *     (`resolveImportAccess` in `doc-store-access.ts`), the same function: a mature rating (`r`,
 *     `x`, `xxx`) only under a ceiling with a mature bit, so an SFW host's token reads no mature-rated
 *     app's records, its own app's or an import's;
 *   - its block: `decideCollectionRead` is passed the token's `civitai_app_block_id`
 *     (`DataReader.appBlockId`), and refuses unless that block is still its client's one approved
 *     block, by the predicate's own resolution (`clientIsOnlySource` / `resolveConsumer`);
 *   - its install: refused while the install is revoked (uninstalled, turned off, or its publisher
 *     banned), by the markers the store's `withBlockScope` reads
 *     ({@link PrivateFeedOptions.instanceRevoked}).
 * A refusal is a stream that holds nothing, as for gate 5: `Delete`s on the next poll. Any other
 * token (a user-exchange token included) has no `block`, and none of this applies to it.
 *
 * A refusal is believed only when it was read: an `apps_disabled` while the run gate's flag cannot
 * be read (a Flipt outage refuses everyone) ends the stream `unavailable` instead of sending
 * `Delete`s ({@link PrivateFeedOptions.runGateReadable}), and so does any failed read.
 *
 * CURSORS. The stored state records the token subject, and a cursor is refused before its state is
 * used for another subject: the request binding in `subscription.ts` is a public digest, so it
 * cannot keep one subject's cursor from another. Cursors expire after
 * {@link PRIVATE_CURSOR_TTL_MS}. Private and public states share one key space in the snapshot
 * store; they are kept apart only by the `p1` state format (which the public feed refuses) and
 * that subject check.
 *
 * A record's URN carries its stored `record_id`, not its key: a private key is unique only within
 * one user's key space. The key itself travels beside the body, as the entity's `key`, and so do
 * the document's `seq`, the entity's `seq`, and its store `version`, the entity's `version` (the
 * number a write's `ifVersion` is compared against; {@link PRIVATE_BODY_FORMAT}): the body stays
 * the document its schemas claim, and a private stream belongs to one user's token, so none of them
 * reaches another user. The public feeds carry none. The HTTP binding sends all three (an SSE
 * upsert is the whole entity); the gRPC binding's `Entity` message has no field for them.
 *
 * THE HEAD. Each poll reads the app namespace's write head (`usage_app.last_seq`, one counter for
 * every collection of the app, `PrivateDocSource.head`) BEFORE its keyset, never after: every write
 * at or below the head had committed when the keyset was read, so it is in what the poll read. A
 * head read after the keyset could name a write that committed between the two reads and that the
 * keyset missed. The stream says it in `meta` ({@link headMeta}): on `live`, the head of the state
 * the cursor names (absent for a state saved before heads were kept, or one that holds nothing);
 * then a `progress` whenever a poll's head differs from the last one sent, after that poll's
 * changes. A refused poll (a stream that holds nothing) reads no head and sends none. A head
 * below the cursor state's, or below the last one sent, means the namespace's seqs restarted (its
 * usage row was wiped: an app deleted and restored), and the stream is `cursor_expired`, at resume
 * and mid-stream, as the public feed's is.
 *
 * THE CURRENT MAJOR. Beside the head, a served stream's `meta` names the collection's current
 * major, `currentMajor` (`CollectionStream.currentMajor`): on `live`, as the first poll resolved it, then in
 * a `progress` whenever a poll resolves another (a major approved since). A stream that holds
 * nothing names none. app-data-go reads it to answer a read that names no major at the current one
 * (`apps/app-data-go/internal/api/major.go`).
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceAdmits, contextAudience } from '~/server/registry-adapter/audience';
import { parseClientIdList } from '~/server/registry-adapter/auth';
import { hasScope } from '~/server/registry-adapter/auth.jwt';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import { createClaimer, docRev, familyDigest } from '~/server/registry-adapter/doc-feed';
import type { AdapterContext, Change, Entity, EventMeta } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { compareCodeUnits, sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';
import { registryUrn } from '~/server/registry-adapter/urn';
import { ratingAllowedForCeiling } from '~/server/utils/rating-ceiling';
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
 * ids a relay exchanges tokens as (a token's `act.sub`), as a client-id list
 * ({@link parseClientIdList}). Unset or empty is the empty set: no private stream exists.
 */
export const parsePrivateRelays = parseClientIdList;

/** Whether the token was presented by one of `relays` (its `act.sub`). */
export function isListedRelay(
  relays: ReadonlySet<string>,
  reader: AdapterContext['reader']
): boolean {
  return !!reader?.actor && relays.has(reader.actor);
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
  if (!isListedRelay(relays, reader)) return 'relay_not_listed';
  if (!hasScope(reader, 'AppDataRead')) return 'scope_missing';
  return null;
}

/** The private reads of the document store (`createDocStorePrivateFeed`). */
export type PrivateDocSource = {
  /** The app namespace's write head (`privateHead`): its newest seq, 0 when nothing was written. */
  head(appId: string): Promise<number>;
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
  'appId' | 'slug' | 'collection' | 'family' | 'currentMajor'
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
  /**
   * Whether the App Blocks run gate's answer for `userId` can be trusted right now: false while the
   * flag it reads cannot be read (Flipt unreachable with no snapshot), when the run gate answers
   * "not enabled" for everyone. Asked only after the predicate refused with `apps_disabled`: an
   * unreadable gate then ends the stream `unavailable` instead of sending `Delete`s.
   */
  runGateReadable: (userId: number) => Promise<boolean>;
  /**
   * Whether a block-exchange token's install is revoked for `userId`'s block token: uninstalled,
   * turned off, or its publisher banned (`BlockRevocation.isRevoked`, the check `withBlockScope`
   * runs on every REST call). Asked only for a token with a `block`. Like the store's, a marker
   * that cannot be read is not a revocation (it answers false).
   */
  instanceRevoked: (blockInstanceId: string, userId: number) => Promise<boolean>;
  /**
   * The private states' store: the same key space as the public feed's, with a retention of its
   * own ({@link PRIVATE_STATE_RETENTION_SECONDS}).
   */
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
  now?: () => number;
};

export const PRIVATE_PAGE = 500;
const STATE_FORMAT = 'p1';
/**
 * The version of what a private entity carries: `k1` was the body plus the record's storage `key`;
 * `k2` added the document's `seq`; `k3` adds its store `version`. It is folded into every private
 * `rev` and into the poll's read digest, so a cursor saved under an earlier format resumes as a
 * change: its read digest no longer matches, every record's rev differs, and each is sent again, now
 * with its key, seq and version. No cursor has to be expired for it.
 */
export const PRIVATE_BODY_FORMAT = 'k3';

/**
 * A private entity's rev: the document feed's `docRev`, under {@link PRIVATE_BODY_FORMAT}, the key
 * and the seq, so it changes whenever anything the entity carries does.
 */
export const privateRev = (
  d: Pick<PrivateFeedDocument, 'key' | 'version' | 'data' | 'seq'>,
  schemas: readonly string[]
) =>
  sha256Hex(
    sortedKeyJson({ f: PRIVATE_BODY_FORMAT, key: d.key, seq: d.seq, rev: docRev(d, schemas) })
  ).slice(0, 16);

/** The `meta` a private stream's `live` and `progress` carry for a head (see the file comment). */
export const headMeta = (seq: number): EventMeta => ({ head: { seq } });
/**
 * A private stream's `meta`: its head ({@link headMeta}) and, beside it, the collection's current
 * major (`currentMajor`, `CollectionStream.currentMajor`) when the stream is served. Undefined when it names
 * neither.
 */
export const privateMeta = (
  head: number | undefined,
  currentMajor: number | undefined
): EventMeta | undefined =>
  head === undefined && currentMajor === undefined
    ? undefined
    : {
        ...(head !== undefined ? headMeta(head) : {}),
        ...(currentMajor !== undefined ? { currentMajor } : {}),
      };
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
  /**
   * A digest of every (record id, version) read, sent or not, under {@link PRIVATE_BODY_FORMAT}:
   * what an unchanged poll compares.
   */
  read: string | null;
  /** When the state was saved, ms: its cursor expires {@link PRIVATE_CURSOR_TTL_MS} after. */
  issuedAt: number;
  /**
   * The head the poll that computed this state read before its keyset; absent in a state that
   * holds nothing, and in one saved before heads were kept.
   */
  head?: number;
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
  ): Promise<{
    next: PrivateState;
    entities: Map<string, Entity>;
    head: number | null;
    /** The collection's current major (`CollectionStream.currentMajor`); undefined when nothing is served. */
    current?: number;
  }> {
    const nothing = () => ({
      next: emptyState(schema, audience),
      entities: new Map<string, Entity>(),
      head: null,
    });
    if (privateTokenGate(opts.relays, reader) !== null) return nothing();
    const { subject, userId, clientId, block } = reader as Reader & { userId: number };
    const stream = await opts.resolve(schema);
    if (!stream) return nothing();
    const { appId, slug, collection, family } = stream;
    // A block-exchange token's install, revoked since it was exchanged (see the file comment).
    if (block && (await opts.instanceRevoked(block.blockInstanceId, userId))) return nothing();
    const decision = await opts.decide(
      {
        userId,
        clientId,
        // The viewer's audience, and for a block-exchange token also its ceiling: the store's rule.
        matureAllowed: (rating) =>
          audienceAdmits(audience, rating) &&
          (block === undefined || ratingAllowedForCeiling(rating, block.maxBrowsingLevel)),
        ...(block ? { appBlockId: block.appBlockId } : {}),
      },
      { sourceBlockId: slug, collection }
    );
    if (!decision.ok) {
      // The run gate reads a flag, and an unreadable flag reads as "not enabled" for everyone: that
      // is an outage, not a revocation, and must not delete what every consumer holds.
      if (decision.reason === 'apps_disabled' && !(await opts.runGateReadable(userId))) {
        throw new ProtocolError('unavailable', 'the App Blocks run gate cannot be read');
      }
      return nothing();
    }
    // The predicate read the app's row itself: it must be the app the catalog named, and still
    // declare the collection private.
    if (decision.source.id !== appId) return nothing();
    if (decision.source.collections.get(collection)?.visibility !== 'private') return nothing();
    if (prev?.appId && prev.appId !== appId) {
      throw cursorExpired('the collection now belongs to a different app');
    }

    const digest = familyDigest(family);
    const current = stream.currentMajor;
    // Before the keyset, never after (see the file comment).
    const head = await opts.source.head(appId);
    // A head below the one this state was read at: the namespace was wiped and written again
    // (an app deleted and restored), so its seqs restarted, and nothing this state holds can be
    // compared with what is there now. As the public feed does.
    if (prev?.appId === appId && prev.head !== undefined && head < prev.head) {
      throw cursorExpired('the namespace seq went back');
    }
    const versions = await readPaged((after) =>
      opts.source.versions(appId, collection, userId, after, PRIVATE_PAGE)
    );
    const read = sha256Hex(
      sortedKeyJson({
        f: PRIVATE_BODY_FORMAT,
        read: versions.map((v) => [v.recordId, v.version, v.seq]).sort(),
      })
    ).slice(0, 32);
    if (prev && prev.appId === appId && prev.family === digest && prev.read === read) {
      return { next: prev, entities: new Map(), head, current };
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
      entities.set(urn, {
        urn,
        schemas,
        rev: privateRev(d, schemas),
        body: d.data,
        key: d.key,
        seq: d.seq,
        version: d.version,
      });
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
        head,
        served: [...entities.values()]
          .map((e) => [e.urn, e.rev] as [string, string])
          .sort((a, b) => compareCodeUnits(a[0], b[0])),
      },
      entities,
      head,
      current,
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
    // The head `live` carried (the loaded state's), then the last one a `progress` carried; and the
    // current major beside it (the first poll's, which `live` carried).
    let sentHead = loaded.head ?? null;
    let sentCurrent = first.current;
    while (!ctx.signal.aborted) {
      const before = state;
      const { next, entities, head, current } =
        pending ?? (await guarded(() => advance(schema, before, ctx.reader, audience)));
      pending = null;
      // The same, against the newest head this stream SENT (a head-only move is not saved in the
      // state, so `advance` compares with an older one).
      if (head !== null && sentHead !== null && head < sentHead) {
        throw cursorExpired('the namespace seq went back');
      }
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
      // After the poll's changes, so a consumer holds all of them when it reads the head. A new
      // current major (a major approved since) is sent the same way, beside the head.
      if (head !== null && (head !== sentHead || current !== sentCurrent)) {
        if (ctx.signal.aborted) return;
        sentHead = head;
        sentCurrent = current;
        yield { progress: position, meta: privateMeta(head, current) as EventMeta };
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
      // `live` carries the head of the state the cursor names: what the consumer holds once it is
      // live. The first poll's changes, and its head, follow it. Beside the head, the collection's
      // current major as the first poll resolved it: a property of the collection now, not of the
      // state, so a state saved before it was named still names it at once.
      const liveMeta = privateMeta(state.head, first.current);
      return Object.assign(follow(schema, cursor, state, first, ctx, audience), {
        ...(liveMeta !== undefined ? { liveMeta } : {}),
      });
    },
  };
}
