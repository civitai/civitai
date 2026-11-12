// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HiddenPreferences from '~/components/HiddenPreferences/useApplyHiddenPreferences';

// The hidden-preference filter has its own tests; here it passes the list through and records
// what it was asked, so what is under test is this hook's own part: the dedupe and the options.
const hidden = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferences>()),
  useApplyHiddenPreferences: (args: Record<string, unknown> & { data: unknown[] }) => {
    hidden.calls.push(args);
    return { items: args.data, loadingPreferences: false, hiddenCount: 0 };
  },
}));

import { useFeedImageItems } from '~/components/Image/image.utils';

type Pages = Parameters<typeof useFeedImageItems>[0];
type Options = Parameters<typeof useFeedImageItems>[1];

function run(pages: Pages, options: Options = {}) {
  let result: ReturnType<typeof useFeedImageItems> | undefined;
  const Harness = () => {
    result = useFeedImageItems(pages, options);
    return null;
  };
  act(() => createRoot(document.createElement('div')).render(createElement(Harness)));
  return result!;
}

// Only the id matters to this hook; the rest of an image is the filter's business.
const image = (id: number) => ({ id } as never);

describe('useFeedImageItems', () => {
  beforeEach(() => {
    hidden.calls = [];
  });

  it('keeps an image that offset paging repeats on a later page once, where it first appeared', () => {
    const { flatData } = run([
      { items: [image(1), image(2), image(3)] },
      { items: [image(3), image(4)] },
    ]);
    expect(flatData.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });

  it('skips a page that has not loaded', () => {
    const { flatData } = run([{ items: [image(1)] }, undefined, { items: [image(2)] }]);
    expect(flatData.map((item) => item.id)).toEqual([1, 2]);
  });

  it("hands the hidden-preference filter the deduped list and the caller's options", () => {
    run([{ items: [image(1), image(1)] }], {
      showHidden: true,
      disabled: true,
      isRefetching: true,
    });
    expect(hidden.calls.at(-1)).toMatchObject({
      type: 'images',
      data: [expect.objectContaining({ id: 1 })],
      showHidden: true,
      disabled: true,
      isRefetching: true,
    });
    expect((hidden.calls.at(-1)?.data as unknown[]).length).toBe(1);
  });
});
