import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { docStoreDocSource } from '~/server/registry-adapter/doc-source';
import type { Change } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import type {
  DocStore,
  DocStoreMaintenance,
  DocStoreModeration,
} from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreMaintenance,
  createDocStoreModeration,
} from '~/server/services/apps/doc-store';
import { createMemorySnapshotStore } from '../../../../../scripts/registry-adapter-fixture/fixture-source';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_DEV, NS_PROD, PREFS, VIEWER_1 } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The SEAM between the registry adapter's document feed (`createDocFeed`) and the real document
 * store: the feed reads the store's own registry feed (`createDocStoreFeed`) through the same
 * mapping the live process uses (`docStoreDocSource`), on the embedded Postgres. Every other feed
 * test reads the fixture source; this one is where a difference between the fixture and the store
 * would show. Writes, hides, unhides, deletes and an app purge go through the store's own APIs.
 */

const MOD = 9_302;
const SLUG = 'seam-board';
const V1 = `urn:schema:apps.civitai.com:${SLUG}/board@v1`;
// Every object fits, so what streams is decided by the store's reads alone.
const FAMILY: CollectionStream['family'] = [
  {
    urn: V1,
    body: { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: V1, type: 'object' },
  },
];
const urn = (key: string) => `urn:apps.civitai.com:${SLUG}/board/${key}`;
const shape = (c: Change) =>
  'upsert' in c ? ['upsert', c.upsert.urn] : 'delete' in c ? ['delete', c.delete] : ['progress'];

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof ProtocolError ? `${err.code}: ${err.message}` : `other: ${String(err)}`;
  }
}

describe.each([{ rls: true }, { rls: false }])(
  'the document feed over the real store (rls %o)',
  (opts) => {
    let h: Harness;
    let store: DocStore;
    let mod: DocStoreModeration;
    let maint: DocStoreMaintenance;
    const snapshots = createMemorySnapshotStore();

    beforeAll(async () => {
      h = await createPgliteHarness(opts);
      store = createDocStore({ db: h.db });
      mod = createDocStoreModeration({ db: h.db });
      maint = createDocStoreMaintenance({ db: h.db });
    });
    afterAll(async () => {
      if (h) expect(h.violations).toEqual([]);
      await h?.close();
    });

    /**
     * A feed of `app`'s board collection. `edits[i]` runs before poll i+1 of `changes`; the
     * subscription stops after `edits.length + 1` polls.
     */
    function feedOf(app: string, edits: Array<() => Promise<unknown>> = []) {
      let polls = 0;
      const abort = new AbortController();
      const feed = createDocFeed({
        source: docStoreDocSource(createDocStoreFeed({ db: h.db })),
        resolve: async (schema) =>
          schema === V1
            ? { appId: app, slug: SLUG, collection: 'board', contentRating: 'pg', family: FAMILY }
            : null,
        store: snapshots,
        pollMs: 1,
        // Every position-only move is saved and reported here: this file pins what the real
        // store's writes look like through the feed, not the save throttle (doc-feed.test.ts).
        progressEveryMs: 0,
        sleep: async () => {
          if (polls >= edits.length) abort.abort();
          else await edits[polls]();
          polls++;
        },
      });
      const drain = async (cursor: string) => {
        const out: Change[] = [];
        for await (const c of await feed.changes(V1, cursor, { signal: abort.signal })) out.push(c);
        return out;
      };
      return { feed, drain };
    }

    async function seeded(tag: string) {
      const app = freshApp(tag);
      const me = ctx(app, NS_PROD, VIEWER_1);
      await store.put(me, BOARD, 'b1', { t: 'one' });
      await store.put(me, BOARD, 'b2', { t: 'two' });
      await store.put(me, PREFS, 'secret', { t: 'PRIVATE-SEAM-CANARY' });
      await store.put(ctx(app, NS_DEV, VIEWER_1), BOARD, 'b9', { t: 'DEV-SEAM-CANARY' });
      return { app, me };
    }

    it('🔴 write, hide, unhide and delete stream as upserts and deletes, and nothing private or dev ever does', async () => {
      const { app, me } = await seeded('seam');
      const snap = await feedOf(app).feed.snapshot(V1);
      expect(snap.entities.map((e) => e.urn)).toEqual([urn('b1'), urn('b2')]);

      const { drain } = feedOf(app, [
        () => store.put(me, BOARD, 'b3', { t: 'three' }),
        () => store.put(me, BOARD, 'b1', { t: 'one, edited' }),
        () => mod.setHidden(app, NS_PROD, 'board', 'b2', true, MOD),
        () => mod.setHidden(app, NS_PROD, 'board', 'b2', false, MOD),
        () => store.delete(me, BOARD, 'b3'),
        async () => {
          await store.put(me, PREFS, 'secret2', { t: 'PRIVATE-SEAM-CANARY' });
          await store.put(ctx(app, NS_DEV, VIEWER_1), BOARD, 'b8', { t: 'DEV-SEAM-CANARY' });
        },
      ]);
      const changes = await drain(snap.cursor);
      expect(changes.map(shape)).toEqual([
        ['upsert', urn('b3')],
        ['upsert', urn('b1')],
        ['delete', urn('b2')],
        ['upsert', urn('b2')],
        ['delete', urn('b3')],
        // The private write moved the production namespace's seq with no change for this
        // stream: reported as progress (spec rule 9), carrying a cursor and nothing else.
        ['progress'],
      ]);
      const edited = changes[1];
      expect('upsert' in edited && edited.upsert.body).toEqual({ t: 'one, edited' });
      const everything = JSON.stringify([snap, changes]);
      for (const canary of ['PRIVATE-SEAM-CANARY', 'DEV-SEAM-CANARY', 'secret']) {
        expect(everything).not.toContain(canary);
      }
    });

    it('a resume from the last cursor, with nothing written since, streams nothing', async () => {
      const { app } = await seeded('seamidle');
      const snap = await feedOf(app).feed.snapshot(V1);
      expect(await feedOf(app, [async () => undefined]).drain(snap.cursor)).toEqual([]);
    });

    it('🔴 an app purge resets the namespace seq: cursor_expired', async () => {
      const { app } = await seeded('seampurge');
      const snap = await feedOf(app).feed.snapshot(V1);
      expect((await maint.purgeApp(app)).done).toBe(true);
      expect(await codeOf(feedOf(app).drain(snap.cursor))).toBe(
        'cursor_expired: the namespace seq went back'
      );
    });

    it('🔴 an app purge written over past the old seq: the witness is gone without a trace', async () => {
      const { app, me } = await seeded('seamover');
      const snap = await feedOf(app).feed.snapshot(V1);
      const before = await createDocStoreFeed({ db: h.db }).feedHead(app);
      expect((await maint.purgeApp(app)).done).toBe(true);
      // New keys only, so nothing recreates the witness.
      for (let i = 0; i <= before; i++) await store.put(me, BOARD, `z${i}`, { i });
      expect(await createDocStoreFeed({ db: h.db }).feedHead(app)).toBeGreaterThan(before);
      expect(await codeOf(feedOf(app).drain(snap.cursor))).toBe(
        'cursor_expired: a document this cursor served is gone without a trace'
      );
    });
  }
);
