// The New training flow lives in component memory, and anything that reloads or remounts it loses it
// (the main app reloads the page when a session ends). This keeps an autosaved copy in the browser's
// IndexedDB, per user, that the flow offers to resume. Only uploaded files are kept: an in-flight upload
// has nothing to resume from but its bytes.
import { cardByType, type LabelType, type Media } from '$lib/data/trainingModels';
import { FLOW_DRAFT_DB } from '@civitai/shared/training-flow-draft';
import { trainingBlobKey } from '$lib/train-core';
import {
  isTrainable,
  type Img,
  type ImgBatch,
  type RunParams,
  type SamplePrompt,
  type Selection,
} from './trainingFlow';

/** Everything but the dataset: the flow's own fields, as plain JSON. */
export interface FlowDraftState {
  selection: Selection;
  labelMode: LabelType;
  trigger: string;
  autoLabel: 'auto' | 'manual';
  excludeTags: string[];
  excludeCharacter: boolean;
  excludeSource: boolean;
  reviewName: string;
  reviewNameSeed: string | null;
  samplePrompts: SamplePrompt[];
  promptsSeed: { labels: string; prompts: string } | null;
  runParams: Record<string, RunParams>;
  paramsSeedTrigger: string;
  paramsSeedLoraType: string;
  presetType: string;
}

/** One uploaded file, minus its bytes (stored apart, so a tag edit never rewrites the media). */
export interface DraftImg {
  key: string;
  name: string;
  mediaType: Media;
  blobId: string;
  /** An https preview that needs no stored bytes (a generation's media URL). */
  previewUrl?: string;
  blobUrl?: string;
  /** `blobUrl` was the tile's own object URL; the restored tile gets its new one. */
  blobUrlIsPreview?: boolean;
  nsfwLevel?: string;
  sourceLabel?: string;
  labelTried?: boolean;
  hash?: string;
  sourceWorkflowId?: string;
  tags: string[];
  caption: string;
  repeats?: number;
  /** The add it came in with, so Manage tags can still scope an edit to it after a reload. */
  batch?: ImgBatch;
}

/** A tile to save, with where its bytes come from. */
export interface DraftEntry {
  img: DraftImg;
  file?: Blob;
  /** The tile's `blob:` preview, read once when there is no file (a reused dataset's blob). */
  localUrl?: string;
}

export interface FlowDraft {
  savedAt: number;
  state: FlowDraftState;
  images: Img[];
}

/** A draft older than this is dropped rather than offered: its uploads may be gone. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const isLocalUrl = (url: string | undefined) => !!url?.startsWith('blob:');

export function draftEntries(images: Img[]): DraftEntry[] {
  return images
    .filter((i) => isTrainable(i) && !!i.blobId)
    .map((i) => {
      const local = isLocalUrl(i.previewUrl);
      return {
        img: {
          key: trainingBlobKey(i.blobId!),
          name: i.name,
          mediaType: i.mediaType,
          blobId: i.blobId!,
          previewUrl: local ? undefined : i.previewUrl || undefined,
          blobUrl: isLocalUrl(i.blobUrl) ? undefined : i.blobUrl,
          blobUrlIsPreview: isLocalUrl(i.blobUrl) && i.blobUrl === i.previewUrl ? true : undefined,
          nsfwLevel: i.nsfwLevel,
          sourceLabel: i.sourceLabel,
          labelTried: i.labelTried,
          hash: i.hash,
          sourceWorkflowId: i.sourceWorkflowId,
          tags: [...i.tags],
          caption: i.caption,
          repeats: i.repeats,
          batch: i.batch && { ...i.batch },
        },
        file: i.file,
        localUrl: !i.file && local ? i.previewUrl : undefined,
      };
    });
}

/** Rebuild the tiles. A tile whose bytes weren't stored gets an empty preview; its `blobId` still trains. */
export function restoreImages(
  saved: DraftImg[],
  media: Map<string, Blob>,
  nextId: () => number,
  objectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob)
): Img[] {
  return saved.map(({ key, blobUrlIsPreview, previewUrl, ...rest }) => {
    const bytes = media.get(key);
    const url = bytes ? objectUrl(bytes) : previewUrl ?? '';
    return {
      ...rest,
      id: nextId(),
      ...(bytes instanceof File ? { file: bytes } : {}),
      previewUrl: url,
      blobUrl: blobUrlIsPreview && bytes ? url : rest.blobUrl,
      status: 'uploaded',
      progress: 1,
    };
  });
}

/** Whether a stored draft can still be offered: recent, and every run's model still in the catalog. */
export function isUsableDraft(savedAt: number, state: FlowDraftState, now = Date.now()): boolean {
  return (
    now - savedAt < DRAFT_MAX_AGE_MS &&
    state.selection.runs.length > 0 &&
    state.selection.runs.every((run) => !!cardByType(run.cardType))
  );
}

const DRAFTS = 'flow-drafts';
const MEDIA = 'flow-draft-media';

interface StoredDraft {
  savedAt: number;
  state: FlowDraftState;
  images: DraftImg[];
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(FLOW_DRAFT_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DRAFTS);
      req.result.createObjectStore(MEDIA);
    };
    req.onsuccess = () => {
      // Let a sign-out's delete through instead of blocking on this open connection.
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const settled = (req: IDBRequest) =>
  new Promise<unknown>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

/** Drop every user's expired draft, so an abandoned one doesn't outlive its age on the device. */
async function sweepExpired(db: IDBDatabase, now = Date.now()) {
  const tx = db.transaction([DRAFTS, MEDIA], 'readwrite');
  const media = tx.objectStore(MEDIA);
  const cursorReq = tx.objectStore(DRAFTS).openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    if (now - (cursor.value as StoredDraft).savedAt >= DRAFT_MAX_AGE_MS) {
      const prefix = `${String(cursor.key)}:`;
      media.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      cursor.delete();
    }
    cursor.continue();
  };
  await done(tx);
}

/** The autosave for one user. Saves and clears run one at a time, in call order, and never throw:
 *  a browser without storage just has no draft. */
export function flowDraftStore(userId: number) {
  const prefix = `${userId}:`;
  const mediaRange = () => IDBKeyRange.bound(prefix, `${prefix}￿`);
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) =>
    (queue = queue.then(work).catch(() => undefined)) as Promise<void>;

  async function write(state: FlowDraftState, entries: DraftEntry[]) {
    const db = await openDb();
    const want = new Set(entries.map((e) => prefix + e.img.key));
    const have = new Set(
      ((await settled(
        db.transaction(MEDIA).objectStore(MEDIA).getAllKeys(mediaRange())
      )) as string[]) ?? []
    );
    // Bytes are read before the write transaction opens: an await on a fetch would end it.
    const fresh: [string, Blob][] = [];
    for (const e of entries) {
      const id = prefix + e.img.key;
      if (have.has(id)) continue;
      const bytes =
        e.file ??
        (e.localUrl
          ? await fetch(e.localUrl)
              .then((r) => r.blob())
              .catch(() => null)
          : null);
      if (bytes) fresh.push([id, bytes]);
    }
    // The labels commit first, on their own: bytes over the storage quota (a video dataset, Safari)
    // abort only their own write, and a tile without bytes still restores and trains by its blobId.
    const tx = db.transaction([DRAFTS, MEDIA], 'readwrite');
    const media = tx.objectStore(MEDIA);
    for (const id of have) if (!want.has(id)) media.delete(id);
    const draft: StoredDraft = {
      savedAt: Date.now(),
      state,
      images: entries.map((e) => e.img),
    };
    tx.objectStore(DRAFTS).put(draft, userId);
    await done(tx);
    for (const [id, bytes] of fresh) {
      const put = db.transaction(MEDIA, 'readwrite');
      put.objectStore(MEDIA).put(bytes, id);
      await done(put).catch(() => undefined);
    }
  }

  const clear = () =>
    enqueue(async () => {
      const db = await openDb();
      const tx = db.transaction([DRAFTS, MEDIA], 'readwrite');
      tx.objectStore(DRAFTS).delete(userId);
      tx.objectStore(MEDIA).delete(mediaRange());
      await done(tx);
    });

  return {
    save: (state: FlowDraftState, entries: DraftEntry[]) => enqueue(() => write(state, entries)),
    clear,

    /** The stored draft, or null when there is none worth offering (a stale one is cleared). */
    async load(nextId: () => number): Promise<FlowDraft | null> {
      try {
        const db = await openDb();
        await sweepExpired(db).catch(() => undefined);
        const tx = db.transaction([DRAFTS, MEDIA]);
        const stored = (await settled(tx.objectStore(DRAFTS).get(userId))) as
          | StoredDraft
          | undefined;
        if (!stored || stored.images.length === 0) return null;
        if (!isUsableDraft(stored.savedAt, stored.state)) {
          void clear();
          return null;
        }
        const store = tx.objectStore(MEDIA);
        const media = new Map<string, Blob>();
        await Promise.all(
          stored.images.map(async ({ key }) => {
            const bytes = (await settled(store.get(prefix + key))) as Blob | undefined;
            if (bytes) media.set(key, bytes);
          })
        );
        return {
          savedAt: stored.savedAt,
          state: stored.state,
          images: restoreImages(stored.images, media, nextId),
        };
      } catch {
        return null;
      }
    },
  };
}
