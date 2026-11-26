import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CARDS } from '$lib/data/trainingModels';
import { FLOW_DRAFT_DB, deleteFlowDrafts } from '@civitai/shared/training-flow-draft';
import {
  DRAFT_MAX_AGE_MS,
  draftEntries,
  draftModelsAllowed,
  flowDraftStore as FlowDraftStore,
  isUsableDraft,
  restoreImages,
  type FlowDraftState,
} from './flowDraft';
import { imagesInScope, newBatch, type Img } from './trainingFlow';
import { removeTag } from './tagReplace';

// train-core (for trainingBlobKey) loads the SDK, whose dist Node's ESM loader refuses.
vi.mock('@civitai/orchestration-client', () => ({}));

const img = (over: Partial<Img> = {}): Img => ({
  id: 1,
  name: 'a.png',
  previewUrl: 'blob:local-a',
  mediaType: 'image',
  status: 'uploaded',
  progress: 1,
  blobId: 'blob-a',
  blobUrl: 'https://orch.example/v2/consumer/blobs/blob-a.png?sig=1',
  tags: [],
  caption: '',
  ...over,
});

let ids = 100;
const nextId = () => ++ids;

describe('draft round trip', () => {
  it('keeps each file in its batch, so a batch-scoped tag edit still holds after a reload', () => {
    const first = newBatch('upload', 1_000);
    const second = newBatch('zip', 2_000);
    const restored = restoreImages(
      draftEntries([
        img({ tags: ['1boy', 'smile'], batch: first }),
        img({ id: 2, name: 'b.png', blobId: 'blob-b', tags: ['1boy'], batch: second }),
      ]).map((e) => e.img),
      new Map(),
      nextId
    );
    expect(restored.map((i) => i.batch)).toEqual([first, second]);
    for (const i of imagesInScope(restored, second.id)) i.tags = removeTag(i.tags, '1boy');
    expect(restored.map((i) => i.tags)).toEqual([['1boy', 'smile'], []]);
  });

  it('brings back every uploaded file with its hand-edited labels', () => {
    const file = new File(['bytes'], 'a.png', { type: 'image/png' });
    const entries = draftEntries([
      img({ file, tags: ['1girl', 'red dress'], repeats: 3, labelTried: true }),
      img({ id: 2, name: 'b.png', blobId: 'blob-b', caption: 'a photo of sks', file }),
    ]);
    const media = new Map(entries.map((e) => [e.img.key, e.file!]));
    const restored = restoreImages(
      entries.map((e) => e.img),
      media,
      nextId,
      () => 'blob:restored'
    );

    expect(restored.map((i) => [i.name, i.tags, i.caption, i.repeats])).toEqual([
      ['a.png', ['1girl', 'red dress'], '', 3],
      ['b.png', [], 'a photo of sks', undefined],
    ]);
    expect(restored[0]).toMatchObject({
      status: 'uploaded',
      blobId: 'blob-a',
      file,
      previewUrl: 'blob:restored',
      // The https media URL is what auto-label sends; it must survive the restore.
      blobUrl: 'https://orch.example/v2/consumer/blobs/blob-a.png?sig=1',
    });
  });

  it('leaves out files that never finished uploading', () => {
    const entries = draftEntries([
      img({ status: 'uploading', blobId: undefined }),
      img({ id: 2, status: 'blocked', blobId: 'blob-x' }),
      img({ id: 3, status: 'error' }),
    ]);
    expect(entries).toEqual([]);
  });

  it("reads a reused blob's bytes from its local preview and points blobUrl at the new one", () => {
    const [entry] = draftEntries([
      img({ previewUrl: 'blob:hydrated', blobUrl: 'blob:hydrated', file: undefined }),
    ]);
    expect(entry).toMatchObject({ localUrl: 'blob:hydrated', file: undefined });
    expect(entry!.img.blobUrl).toBeUndefined();

    const [restored] = restoreImages(
      [entry!.img],
      new Map([[entry!.img.key, new Blob(['x'])]]),
      nextId,
      () => 'blob:new'
    );
    expect(restored).toMatchObject({ previewUrl: 'blob:new', blobUrl: 'blob:new' });
    expect(restored!.file).toBeUndefined();
  });

  it('keeps an https preview without stored bytes', () => {
    const url = 'https://orch.example/gen.png';
    const [entry] = draftEntries([img({ previewUrl: url, blobUrl: url, file: undefined })]);
    expect(entry!.localUrl).toBeUndefined();
    const [restored] = restoreImages([entry!.img], new Map(), nextId);
    expect(restored).toMatchObject({ previewUrl: url, blobUrl: url });
  });
});

describe('draftModelsAllowed', () => {
  const gated = MODEL_CARDS.find((c) => c.flagKey)!;
  const open = MODEL_CARDS.find((c) => !c.flagKey && !c.versions[0]!.flagKey)!;
  const draftOn = (card: (typeof MODEL_CARDS)[number]) =>
    ({
      selection: {
        media: 'image',
        loraType: 'character',
        runs: [{ id: 1, cardType: card.type, versionKey: card.versions[0]!.key }],
      },
    } as FlowDraftState);

  it('lets an ungated model resume for anyone', () => {
    expect(draftModelsAllowed(draftOn(open), new Set())).toBe(true);
  });

  it("refuses a gated model once the viewer's gate is closed, and allows it while open", () => {
    expect(draftModelsAllowed(draftOn(gated), new Set())).toBe(false);
    expect(
      draftModelsAllowed(
        draftOn(gated),
        new Set([gated.flagKey!, ...gated.versions.map((v) => v.flagKey!).filter(Boolean)])
      )
    ).toBe(true);
  });
});

describe('isUsableDraft', () => {
  const state = (cardType: string) =>
    ({
      selection: {
        media: 'image',
        loraType: 'character',
        runs: [{ id: 1, cardType, versionKey: 'x' }],
      },
    } as FlowDraftState);
  const now = 10 * DRAFT_MAX_AGE_MS;

  it('offers a recent draft on a catalog model', () => {
    expect(isUsableDraft(now - 60_000, state(MODEL_CARDS[0]!.type), now)).toBe(true);
  });

  it('drops a draft past its age, or on a model no longer in the catalog', () => {
    expect(isUsableDraft(now - DRAFT_MAX_AGE_MS, state(MODEL_CARDS[0]!.type), now)).toBe(false);
    expect(isUsableDraft(now - 60_000, state('retired-model'), now)).toBe(false);
  });
});

describe('flowDraftStore', () => {
  const DAY = 24 * 60 * 60 * 1000;
  let flowDraftStore: typeof FlowDraftStore;

  // A fresh database and a fresh module each time: the module caches its connection and its
  // "deleted by a sign-out" latch.
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ({ flowDraftStore } = await import('./flowDraft'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const state = (over: Partial<FlowDraftState> = {}) =>
    ({
      selection: {
        media: 'image',
        loraType: 'character',
        runs: [
          { id: 1, cardType: MODEL_CARDS[0]!.type, versionKey: MODEL_CARDS[0]!.versions[0]!.key },
        ],
      },
      trigger: 'sks',
      submitKey: 'submit-1',
      ...over,
    } as FlowDraftState);
  const file = (name: string) => new File([`bytes of ${name}`], name, { type: 'image/png' });
  const tiles = () =>
    draftEntries([
      img({ file: file('a.png'), tags: ['1girl', 'red dress'] }),
      img({
        id: 2,
        name: 'b.png',
        blobId: 'blob-b',
        file: file('b.png'),
        caption: 'a photo of sks',
      }),
    ]);

  /** What is in the database, read past the store. */
  async function stored() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(FLOW_DRAFT_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const keys = (name: string) =>
      new Promise<IDBValidKey[]>((resolve, reject) => {
        if (!db.objectStoreNames.contains(name)) return resolve([]);
        const req = db.transaction(name).objectStore(name).getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const result = { drafts: await keys('flow-drafts'), media: await keys('flow-draft-media') };
    db.close();
    return result;
  }

  it('brings a saved draft back with its settings, labels and bytes', async () => {
    const store = flowDraftStore(1);
    await store.save(state(), tiles());

    const draft = await store.load(nextId);
    expect(draft?.state).toMatchObject({ trigger: 'sks', submitKey: 'submit-1' });
    expect(draft?.images.map((i) => [i.name, i.blobId, i.tags, i.caption])).toEqual([
      ['a.png', 'blob-a', ['1girl', 'red dress'], ''],
      ['b.png', 'blob-b', [], 'a photo of sks'],
    ]);
    for (const i of draft!.images) {
      expect(i.previewUrl).toMatch(/^blob:/);
      expect(await (await fetch(i.previewUrl)).text()).toBe(`bytes of ${i.name}`);
    }
  });

  it("keeps each user's draft to themselves", async () => {
    await flowDraftStore(1).save(state(), tiles());
    const other = flowDraftStore(2);
    expect(await other.load(nextId)).toBeNull();

    await other.save(state({ trigger: 'other' }), tiles().slice(0, 1));
    await other.clear();
    expect((await flowDraftStore(1).load(nextId))?.images).toHaveLength(2);
    expect(await stored()).toEqual({
      drafts: [1],
      media: ['1:' + tiles()[0]!.img.key, '1:' + tiles()[1]!.img.key],
    });
  });

  it("restores every tile's labels when the bytes go over the storage quota", async () => {
    const put = IDBObjectStore.prototype.put;
    // The quota refuses a.png's bytes the way a browser does: the request is made, its transaction aborts.
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key
    ) {
      const req = put.call(this, value, key);
      if (value instanceof Blob && String(key).endsWith(tiles()[0]!.img.key))
        this.transaction.abort();
      return req;
    });
    const store = flowDraftStore(1);
    await store.save(state(), tiles());

    const draft = await store.load(nextId);
    expect(draft?.images.map((i) => [i.name, i.blobId, i.tags, i.previewUrl === ''])).toEqual([
      ['a.png', 'blob-a', ['1girl', 'red dress'], true],
      ['b.png', 'blob-b', [], false],
    ]);
  });

  it('drops the bytes of a tile removed from the dataset', async () => {
    const store = flowDraftStore(1);
    await store.save(state(), tiles());
    await store.save(state(), tiles().slice(1));
    expect((await stored()).media).toEqual(['1:' + tiles()[1]!.img.key]);
  });

  it('saves in call order, so the newest save wins and a clear after it leaves nothing', async () => {
    const store = flowDraftStore(1);
    void store.save(state({ trigger: 'first' }), tiles());
    await store.save(state({ trigger: 'second' }), tiles().slice(0, 1));
    expect((await store.load(nextId))?.state.trigger).toBe('second');

    void store.save(state({ trigger: 'third' }), tiles());
    await store.clear();
    expect(await store.load(nextId)).toBeNull();
    expect(await stored()).toEqual({ drafts: [], media: [] });
  });

  it('writes nothing once ended, not even a save already reading its bytes', async () => {
    let release!: (r: Response) => void;
    const fetchBytes = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal('fetch', fetchBytes);
    const store = flowDraftStore(1);
    const reused = draftEntries([img({ previewUrl: 'blob:reused', file: undefined })]);
    const inProgress = store.save(state({ trigger: 'late' }), reused);
    await vi.waitFor(() => expect(fetchBytes).toHaveBeenCalledWith('blob:reused'));

    await store.end();
    release(new Response('reused bytes'));
    await inProgress;
    await store.save(state({ trigger: 'after end' }), tiles());
    expect(await stored()).toEqual({ drafts: [], media: [] });
  });

  it('stops writing bytes once ended between one file and the next', async () => {
    const store = flowDraftStore(1);
    const put = IDBObjectStore.prototype.put;
    let ending: Promise<void> | undefined;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key
    ) {
      if (value instanceof Blob) ending ??= store.end();
      return put.call(this, value, key);
    });
    await store.save(state(), tiles());
    await ending;
    expect(await stored()).toEqual({ drafts: [], media: [] });
  });

  it('never writes a draft back after a sign-out deletes the database', async () => {
    const store = flowDraftStore(1);
    await store.save(state(), tiles());
    await deleteFlowDrafts(5_000);
    await store.save(state({ trigger: 'after sign-out' }), tiles());
    expect(await store.load(nextId)).toBeNull();
    expect(await stored()).toEqual({ drafts: [], media: [] });
  });

  it("sweeps any user's draft past its age, with its bytes", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000 * DAY);
    await flowDraftStore(2).save(state(), tiles());
    vi.setSystemTime(1_007 * DAY);

    expect(await flowDraftStore(1).load(nextId)).toBeNull();
    expect(await stored()).toEqual({ drafts: [], media: [] });
  });

  it('clears a draft whose model has left the catalog instead of offering it', async () => {
    const store = flowDraftStore(1);
    const retired = state();
    retired.selection.runs[0]!.cardType = 'retired-model';
    await store.save(retired, tiles());

    expect(await store.load(nextId)).toBeNull();
    await vi.waitFor(async () => expect(await stored()).toEqual({ drafts: [], media: [] }));
  });
});
