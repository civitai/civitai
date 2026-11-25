/**
 * PER-VIEWER STREAMS: one signed-in viewer's OWN documents of one shared collection major, and the
 * viewer's level mask, on the collection's per-viewer URN
 * (`urn:schema:apps.civitai.com:<slug>/<collection>.viewer@v<N>`, `viewerSchemaUrn`). The other
 * half of the shared read `apps/app-data-go/WRITES-DESIGN.md` describes ("The shape: one stream per
 * level bit, one small stream per viewer"): the level streams (`level-feed.ts`) carry the board,
 * shared by every viewer; this stream carries what differs for one viewer, and is the gate that
 * decides whether that viewer is served the level streams at all. Under the generic core
 * (`docs/app-storage-generic-core.md`, "Registry and app-data-go impact") it carries no marks: a
 * vote is the viewer's own document like any other.
 *
 * OFF unless `REGISTRY_ADAPTER_VIEWER_STREAMS=1` and `REGISTRY_ADAPTER_PRIVATE_RELAYS` names a
 * relay; off, a per-viewer URN is not served (`end`, as any schema this source does not serve).
 *
 * WHAT IT HOLDS. Every visible (not deleted, not moderator-hidden) document of the collection whose
 * author is the token's user, exactly as REST's author arm of `sharedDocLevelVisible` shows them to
 * that author: with content levels on, an unrated, pending or stale-rated document always and a
 * rated one only within the token's DOMAIN ceiling (`domainDocLevel` of a block-exchange token's
 * `civitai_max_browsing_level`; a token with no block binding, `audienceDocLevel` of its
 * audience); with levels off, every one. Never a counter document. Each entity is a PLAIN document,
 * exactly as a level stream carries it (body, `key`, `seq`, `version`, `createdAt`, `updatedAt`),
 * under the shared document's KEY URN, so a consumer holding both streams sees one document under
 * one URN. A viewer's document is on this stream whatever its rating, and also on the level stream
 * of its bit once rated: the consumer deduplicates by key.
 *
 * THE META. `live` and every `progress` carry `{head: {seq}, levels: "on"|"off", keyedBy?, mask?}`:
 *   - `head`: the app namespace's write head, read BEFORE the rows (as the private and level feeds
 *     read it): every write at or below it is in what the poll read;
 *   - `levels`: the app's content-levels mode (`app-blocks-shared-doc-levels`; unreadable is on);
 *   - `keyedBy`: the collection's declared `keyedBy`, absent when it declares none;
 *   - `mask`: the viewer's level mask, the level bits of others' documents this viewer may be
 *     served (an integer within 31): for a block-exchange token
 *     `resolveViewerBrowsingLevel(ceiling, viewer level)` when the token carries the viewer's level,
 *     else (a token minted before the hub wrote it) `audienceDocLevel(audience) & ceiling`; ANDed
 *     with `audienceDocLevel(audience)` in both cases, which carries the region hold; for a token
 *     with no block binding, `audienceDocLevel(audience)`.
 *
 * AN EXPLICIT REFUSAL. When the viewer is refused (the private feed's token gate: no user, a relay
 * not listed, no `AppDataRead`; a block-exchange token's revoked install; or the collection-read
 * predicate refusing), the stream holds nothing (`Delete`s for whatever it held) and its meta names
 * NO `mask`. A consumer must read that as "refused", never as an empty collection: the stream never
 * sends an empty stream WITH a mask for a refused viewer. A later poll that admits the viewer again
 * sends a meta with the mask and upserts the documents again. An `apps_disabled` refusal while the
 * run gate cannot be read ends the stream `unavailable` instead, as the private feed's does.
 *
 * NOT RESOLVED. A schema whose collection does not resolve (no approved app, not a shared
 * collection, a major not minted, or the predicate's app is not the catalog's) ends the stream
 * with `end` `{reason: "not_resolved"}`, never a refusal: a catalog lag must not read as one.
 *
 * BINDINGS. The stored state binds the schema, the token subject, the audience, and the block
 * binding's ceiling and viewer level; a resume under another of any is `cursor_expired`. Cursors are
 * `v1.<32 hex>` (bound-wrapped by `subscription.ts`, as every cursor) and expire as the private
 * feed's do.
 *
 * HTTP ONLY: the gRPC `Entity` has no field for what an entity carries beside its body.
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceAdmits, contextAudience } from '~/server/registry-adapter/audience';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import { createClaimer, familyDigest } from '~/server/registry-adapter/doc-feed';
import { levelRev } from '~/server/registry-adapter/level-feed';
import type {
  DecideCollectionRead,
  PrivateFeedOptions,
} from '~/server/registry-adapter/private-feed';
import {
  PRIVATE_CURSOR_TTL_MS,
  headMeta,
  privateTokenGate,
} from '~/server/registry-adapter/private-feed';
import type { AdapterContext, Change, Entity, EventMeta } from '~/server/registry-adapter/protocol';
import { ProtocolError, StreamEnd, cursorExpired } from '~/server/registry-adapter/protocol';
import { compareCodeUnits, sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';
import { parseViewerSchemaUrn, registryUrn } from '~/server/registry-adapter/urn';
import { ratingAllowedForCeiling } from '~/server/utils/rating-ceiling';
import { audienceDocLevel, domainDocLevel } from '~/server/services/apps/doc-levels';
import type { LevelStreamDocument, ViewerFeedVersion } from '~/server/services/apps/doc-store';
import { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-viewer-ceiling';
import { onlySelectableLevels } from '~/shared/constants/browsingLevel.constants';

/** `REGISTRY_ADAPTER_VIEWER_STREAMS`: exactly `1` turns the per-viewer streams on. */
export const viewerStreamsOn = (raw: string | undefined) => raw === '1';

/** The per-viewer reads of the document store (`createDocStorePrivateFeed`'s viewer reads). */
export type ViewerDocSource = {
  head(appId: string): Promise<number>;
  versions(
    appId: string,
    coll: string,
    userId: number,
    domain: number | null,
    afterKey: string,
    limit: number
  ): Promise<ViewerFeedVersion[]>;
  documents(
    appId: string,
    coll: string,
    userId: number,
    domain: number | null,
    afterKey: string,
    limit: number
  ): Promise<LevelStreamDocument[]>;
};

/** A shared collection major a per-viewer URN names, resolved now. */
export type ViewerCollectionStream = Pick<
  CollectionStream,
  'appId' | 'slug' | 'collection' | 'family'
> & {
  /** The collection's own schema URN (`@v<N>`): what each entity's schemas must include. */
  collectionSchema: string;
  /** Content levels on for the app (an unreadable flag counts as on). */
  levelsOn: boolean;
};

export type ResolveViewerStream = (schema: string) => Promise<ViewerCollectionStream | null>;

export type ViewerFeedOptions = {
  /** The private feed's relays (`parsePrivateRelays`); empty serves nothing to anyone. */
  relays: ReadonlySet<string>;
  source: ViewerDocSource;
  resolve: ResolveViewerStream;
  decide: DecideCollectionRead;
  runGateReadable: PrivateFeedOptions['runGateReadable'];
  instanceRevoked: PrivateFeedOptions['instanceRevoked'];
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
  now?: () => number;
};

export const VIEWER_PAGE = 500;
const STATE_FORMAT = 'v1';
const CURSOR_RE = /^v1\.([0-9a-f]{32})$/;
/** Folded into the read digest, so a change to what an entity carries re-sends every entity. */
const VIEWER_BODY_FORMAT = 'w1';

type ViewerState = {
  v: typeof STATE_FORMAT;
  schema: string;
  subject: string;
  audience: string;
  /** The block binding's ceiling and viewer level, null without a binding (or level). */
  ceiling: number | null;
  viewerLevel: number | null;
  appId: string;
  family: string;
  /** The head the poll that computed this state read, before its rows. */
  head: number;
  levels: 'on' | 'off';
  keyedBy: string | null;
  /** The viewer's mask; null while the viewer is refused (see AN EXPLICIT REFUSAL). */
  mask: number | null;
  /** A digest of every (key, version, seq) read: what an unchanged poll compares. */
  read: string | null;
  issuedAt: number;
  served: Array<[urn: string, rev: string]>;
};

type Reader = NonNullable<AdapterContext['reader']>;

/** The meta a state's `live` or `progress` carries (see THE META). */
export function viewerMeta(
  state: Pick<ViewerState, 'head' | 'levels' | 'keyedBy' | 'mask'>
): EventMeta {
  return {
    ...headMeta(state.head),
    levels: state.levels,
    ...(state.keyedBy ? { keyedBy: state.keyedBy } : {}),
    ...(state.mask !== null ? { mask: state.mask } : {}),
  };
}

/**
 * The viewer's level mask (see THE META): the level bits of others' documents this token may be
 * served, held to the audience (its region hold included).
 */
export function viewerMask(reader: Pick<Reader, 'block'>, audience: Audience): number {
  const held = audienceDocLevel(audience.allowed);
  const block = reader.block;
  if (!block) return held;
  if (block.viewerBrowsingLevel !== null) {
    return (
      resolveViewerBrowsingLevel({
        maxBrowsingLevel: block.maxBrowsingLevel,
        viewerBrowsingLevel: block.viewerBrowsingLevel,
      }) & held
    );
  }
  return held & onlySelectableLevels(block.maxBrowsingLevel);
}

const end = (reason: 'not_resolved') => new StreamEnd({ reason });

export function createViewerFeed(opts: ViewerFeedOptions) {
  const claimer = createClaimer();
  const now = opts.now ?? Date.now;

  const stateKey = (s: Pick<ViewerState, 'schema' | 'subject' | 'audience'>) =>
    `${s.schema}#viewer#${s.subject}#${s.audience}`;

  const save = async (state: ViewerState): Promise<string> => {
    const stamped = { ...state, issuedAt: now() };
    const raw = sortedKeyJson(stamped);
    const digest = sha256Hex(raw).slice(0, 32);
    await opts.store.put(digest, raw, stateKey(state));
    return `${STATE_FORMAT}.${digest}`;
  };

  /** Refused here before anything is read: over gRPC, or with no reader at all. */
  const requested = (ctx: AdapterContext) => {
    if (ctx.binding === 'grpc') {
      throw new ProtocolError(
        'bad_request',
        'per-viewer streams are served over the HTTP binding only: a gRPC Entity has no field for key, seq, version, createdAt or updatedAt'
      );
    }
  };

  const bindingOf = (reader: AdapterContext['reader']) => ({
    ceiling: reader?.block?.maxBrowsingLevel ?? null,
    viewerLevel: reader?.block?.viewerBrowsingLevel ?? null,
  });

  const load = async (
    schema: string,
    cursor: string,
    ctx: AdapterContext,
    audience: Audience
  ): Promise<ViewerState> => {
    const digest = CURSOR_RE.exec(cursor)?.[1];
    if (!digest) throw cursorExpired('not a cursor this source issued');
    const raw = await opts.store.get(digest);
    if (raw === null) throw cursorExpired('the state this cursor names is no longer held');
    let state: ViewerState;
    try {
      state = JSON.parse(raw) as ViewerState;
    } catch {
      throw cursorExpired('the state this cursor names is unreadable');
    }
    if (state.v !== STATE_FORMAT || state.schema !== schema) {
      throw cursorExpired('the cursor belongs to another stream');
    }
    if (state.subject !== (ctx.reader?.subject ?? '')) {
      throw cursorExpired('the cursor was issued to another token subject');
    }
    if (state.audience !== audience.key) {
      throw cursorExpired('the cursor was issued to a token that may read different ratings');
    }
    const binding = bindingOf(ctx.reader);
    if (state.ceiling !== binding.ceiling || state.viewerLevel !== binding.viewerLevel) {
      throw cursorExpired('the cursor was issued to a token with another level binding');
    }
    if (!(now() - state.issuedAt <= PRIVATE_CURSOR_TTL_MS)) {
      throw cursorExpired('the cursor is older than a per-viewer stream keeps');
    }
    await opts.store.touch(digest, stateKey(state));
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
      if (rows.length < VIEWER_PAGE) return out;
      after = rows[rows.length - 1].key;
    }
  }

  /**
   * The stream's state now, from `prev` (null for a snapshot), and the entities to upsert. Throws
   * {@link StreamEnd} `not_resolved` when the collection does not resolve now.
   */
  async function advance(
    schema: string,
    prev: ViewerState | null,
    ctx: AdapterContext,
    audience: Audience
  ): Promise<{ next: ViewerState; entities: Map<string, Entity> }> {
    const s = await opts.resolve(schema);
    if (!s) throw end('not_resolved');
    if (prev && prev.appId !== s.appId) {
      throw cursorExpired('the collection now belongs to a different app');
    }
    const digest = familyDigest(s.family);
    // The head, BEFORE any row (as the private and level feeds read it).
    const head = await opts.source.head(s.appId);
    if (prev && head < prev.head) throw cursorExpired('the namespace seq went back');

    const reader = ctx.reader;
    const base = {
      v: STATE_FORMAT,
      schema,
      subject: reader?.subject ?? '',
      audience: audience.key,
      ...bindingOf(reader),
      appId: s.appId,
      family: digest,
      head,
      levels: s.levelsOn ? 'on' : 'off',
      issuedAt: 0,
    } as const;
    const refused = (keyedBy: string | null) => ({
      next: { ...base, keyedBy, mask: null, read: null, served: [] },
      entities: new Map<string, Entity>(),
    });

    if (privateTokenGate(opts.relays, reader) !== null) return refused(prev?.keyedBy ?? null);
    const { userId, clientId, block } = reader as Reader & { userId: number };
    if (block && (await opts.instanceRevoked(block.blockInstanceId, userId))) {
      return refused(prev?.keyedBy ?? null);
    }
    const decision = await opts.decide(
      {
        userId,
        clientId,
        matureAllowed: (rating) =>
          audienceAdmits(audience, rating) &&
          (block === undefined || ratingAllowedForCeiling(rating, block.maxBrowsingLevel)),
        ...(block ? { appBlockId: block.appBlockId } : {}),
      },
      { sourceBlockId: s.slug, collection: s.collection }
    );
    if (!decision.ok) {
      if (decision.reason === 'apps_disabled' && !(await opts.runGateReadable(userId))) {
        throw new ProtocolError('unavailable', 'the App Blocks run gate cannot be read');
      }
      return refused(prev?.keyedBy ?? null);
    }
    // The predicate read the app's row itself: it must be the app the catalog named, and still
    // declare the collection shared. Anything else is a resolution the catalog has not caught up
    // with, not a refusal.
    const decl = decision.source.collections.get(s.collection);
    if (decision.source.id !== s.appId || decl?.visibility !== 'shared') throw end('not_resolved');
    const keyedBy = decl.keyedBy ?? null;
    const mask = viewerMask(reader as Reader, audience);
    const domain = s.levelsOn
      ? block
        ? domainDocLevel({ maxBrowsingLevel: block.maxBrowsingLevel })
        : audienceDocLevel(audience.allowed)
      : null;

    const versions = await readPaged((after) =>
      opts.source.versions(s.appId, s.collection, userId, domain, after, VIEWER_PAGE)
    );
    const read = sha256Hex(
      sortedKeyJson({
        f: VIEWER_BODY_FORMAT,
        read: versions.map((v) => [v.key, v.version, v.seq]),
      })
    ).slice(0, 32);
    const meta = { ...base, keyedBy, mask, read };
    if (prev && prev.mask !== null && prev.family === digest && prev.read === read) {
      return { next: { ...meta, served: prev.served }, entities: new Map() };
    }

    const claims = claimer(s.family, digest);
    const entities = new Map<string, Entity>();
    const docs = await readPaged((after) =>
      opts.source.documents(s.appId, s.collection, userId, domain, after, VIEWER_PAGE)
    );
    for (const d of docs) {
      const schemas = claims(d.data);
      if (!schemas.includes(s.collectionSchema)) continue;
      const urn = registryUrn({
        kind: 'document',
        slug: s.slug,
        collection: s.collection,
        key: d.key,
      });
      entities.set(urn, {
        urn,
        schemas,
        rev: levelRev(d, schemas),
        body: d.data,
        key: d.key,
        seq: d.seq,
        version: d.version,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
    }
    return {
      next: {
        ...meta,
        served: [...entities.values()]
          .map((e) => [e.urn, e.rev] as [string, string])
          .sort((a, b) => compareCodeUnits(a[0], b[0])),
      },
      entities,
    };
  }

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProtocolError || err instanceof StreamEnd) throw err;
      opts.onError?.(err);
      throw new ProtocolError('unavailable', 'the per-viewer stream could not be read');
    }
  };

  async function* follow(
    schema: string,
    cursor: string,
    loaded: ViewerState,
    first: Awaited<ReturnType<typeof advance>>,
    ctx: AdapterContext,
    audience: Audience,
    sentMeta: string
  ): AsyncGenerator<Change> {
    let state = loaded;
    let position = cursor;
    let pending: Awaited<ReturnType<typeof advance>> | StreamEnd | null = first;
    let sent = sentMeta;
    while (!ctx.signal.aborted) {
      const before = state;
      let step: Awaited<ReturnType<typeof advance>> | StreamEnd;
      if (pending !== null) step = pending;
      else {
        try {
          step = await guarded(() => advance(schema, before, ctx, audience));
        } catch (err) {
          if (!(err instanceof StreamEnd)) throw err;
          step = err;
        }
      }
      pending = null;
      if (step instanceof StreamEnd) {
        if (!ctx.signal.aborted) yield { end: step.meta };
        return;
      }
      const { next, entities } = step;
      // Against the newest head this stream SENT, too (a head-only move is not saved).
      const sentHead = (JSON.parse(sent) as { head?: { seq?: number } }).head?.seq;
      if (sentHead !== undefined && next.head < sentHead) {
        throw cursorExpired('the namespace seq went back');
      }
      const was = new Map(before.served);
      const still = new Set(next.served.map(([urn]) => urn));
      const deletes = [...was.keys()].filter((urn) => !still.has(urn)).sort(compareCodeUnits);
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
          yield 'upsert' in c ? { upsert: c.upsert, cursor: at } : { delete: c.delete, cursor: at };
        }
        position = nextCursor;
      }
      // After the poll's changes, so a consumer holds all of them when it reads the meta.
      const meta = viewerMeta(state);
      const key = sortedKeyJson(meta);
      if (key !== sent) {
        if (ctx.signal.aborted) return;
        sent = key;
        yield { progress: position, meta };
      }
      await opts.sleep(opts.pollMs, ctx.signal);
    }
  }

  return {
    /** Whether a subscription's schema is a per-viewer URN (by shape; resolved per poll). */
    routes(schema: string): boolean {
      return parseViewerSchemaUrn(schema) !== null;
    },

    /** Whether a cursor is one this feed issued. */
    issued(cursor: string): boolean {
      return CURSOR_RE.test(cursor);
    },

    async snapshot(schema: string, ctx: AdapterContext) {
      requested(ctx);
      const audience = contextAudience(ctx);
      const { next, entities } = await guarded(() => advance(schema, null, ctx, audience));
      const cursor = await guarded(() => save(next));
      return { cursor, entities: [...entities.values()] };
    },

    async changes(schema: string, cursor: string, ctx: AdapterContext) {
      requested(ctx);
      const audience = contextAudience(ctx);
      const state = await guarded(() => load(schema, cursor, ctx, audience));
      const first = await guarded(() => advance(schema, state, ctx, audience));
      // `live` carries the loaded state's head (what the consumer holds once live) and the FIRST
      // poll's admission: a viewer refused since the cursor was issued is refused at `live`, never
      // served one poll on an old mask.
      const liveMeta = viewerMeta({ ...first.next, head: state.head });
      return Object.assign(
        follow(schema, cursor, state, first, ctx, audience, sortedKeyJson(liveMeta)),
        { liveMeta }
      );
    },
  };
}
