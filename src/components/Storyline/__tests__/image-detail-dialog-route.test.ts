import { describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({ default: () => () => null }));

import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';
import '~/components/Dialog/routed-dialog/image-detail.dialog';

const { resolve } = routedDialogDictionary.getItems().imageDetail;

describe('imageDetail route', () => {
  it('puts the storyline chapter in the URL, where storyline mode reads it, not in dialog state', () => {
    const result = resolve(
      { dialog: 'imageDetail' },
      { imageId: 3, storylineChapterId: 45, images: [] }
    );
    expect(result.query).toEqual({ dialog: 'imageDetail', imageId: 3, storylineChapter: 45 });
    expect(result.asPath).toBe('/images/3?storylineChapter=45');
    expect(result.state).toEqual({ images: [] });
  });

  it('carries the route past a rejoin, so the dialog reads the same path as the link', () => {
    const result = resolve(
      { id: 2 },
      { imageId: 3, storylineChapterId: 60, storylineVia: [13, 42] }
    );
    expect(result.query).toEqual({
      id: 2,
      imageId: 3,
      storylineChapter: 60,
      storylineVia: '13,42',
    });
    expect(result.asPath).toBe('/images/3?storylineChapter=60&storylineVia=13,42');
    expect(result.state).toEqual({});
  });

  it('leaves a plain image link unchanged', () => {
    const result = resolve({}, { imageId: 3 });
    expect(result.query).toEqual({ imageId: 3 });
    expect(result.asPath).toBe('/images/3');
  });
});
