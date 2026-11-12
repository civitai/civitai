import { describe, expect, it } from 'vitest';
import { createBatchComposerStore } from '../batch-composer.store';
import type { PlannedPost, UploadedMedia } from '../batch-composer.utils';

const media = (n: number) => ({ status: 'added', url: `u${n}`, name: `${n}.png` } as UploadedMedia);
const post = (key: string, urls: number[]): PlannedPost => ({
  key,
  title: null,
  publishedAt: new Date('2030-01-01T00:00:00Z'),
  media: urls.map(media),
});
const urlsOf = (store: ReturnType<typeof createBatchComposerStore>, key: string) =>
  store
    .getState()
    .reviewPlan?.find((x) => x.key === key)
    ?.media.map((x) => x.url);

describe('reorderReviewMedia', () => {
  const setup = () => {
    const store = createBatchComposerStore({ promotedVersionId: null, titleTemplate: '' });
    store.getState().openReview([post('a', [1, 2, 3, 4]), post('b', [5, 6])]);
    return store;
  };

  it('moves an image to the place of the one it is dropped on, and keeps the post key', () => {
    const store = setup();
    store.getState().reorderReviewMedia('a', 'u4', 'u1');
    expect(urlsOf(store, 'a')).toEqual(['u4', 'u1', 'u2', 'u3']);
    expect(store.getState().reviewPlan?.map((x) => x.key)).toEqual(['a', 'b']);
    store.getState().reorderReviewMedia('a', 'u4', 'u3');
    expect(urlsOf(store, 'a')).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('leaves other posts alone and ignores unknown or identical urls', () => {
    const store = setup();
    store.getState().reorderReviewMedia('a', 'u1', 'u4');
    expect(urlsOf(store, 'b')).toEqual(['u5', 'u6']);
    store.getState().reorderReviewMedia('a', 'u5', 'u1'); // u5 belongs to another post
    store.getState().reorderReviewMedia('a', 'u2', 'u2');
    expect(urlsOf(store, 'a')).toEqual(['u2', 'u3', 'u4', 'u1']);
  });
});
