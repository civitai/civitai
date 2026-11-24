import { describe, expect, it, vi } from 'vitest';
import { MODEL_CARDS } from '$lib/data/trainingModels';
import {
  DRAFT_MAX_AGE_MS,
  draftEntries,
  draftModelsAllowed,
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
