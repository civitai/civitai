import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import {
  LOADABLE_IMAGE_DATA_URI,
  PHONE_VIEWPORT,
  nextLayout,
  renderAtViewport,
} from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const coverImage = {
  entityType: 'Model',
  entityId: 1,
  id: 10,
  url: LOADABLE_IMAGE_DATA_URI,
  width: 512,
  height: 640,
  name: null,
  type: 'image',
  eventDecoration: {
    id: 99,
    data: { type: 'hat', event: 'birthday2026', url: LOADABLE_IMAGE_DATA_URI },
  },
};

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'image.getEntitiesCoverImage': {
      useQuery: () => ({ data: [coverImage], isLoading: false, isRefetching: false }),
    },
  }),
}));

import { ShowcaseItemsInput } from '~/components/Profile/ShowcaseItemsInput';

describe('ShowcaseItemsInput on a phone', () => {
  test('a hatted item has no hat, and its delete button is the topmost thing at its centre', async () => {
    const onChange = vi.fn();
    const { observed } = await renderAtViewport(
      <ShowcaseItemsInput value={[{ entityType: 'Model', entityId: 1 }]} onChange={onChange} />,
      PHONE_VIEWPORT
    );
    expect(observed.width).toBe(390);
    await nextLayout();

    const button = document.querySelector(
      'button.selectedItemRemove, button[class*="selectedItemRemove"]'
    );
    expect(button, 'the remove button rendered').not.toBeNull();
    expect(document.querySelector('[data-event-decoration="hat"]')).toBeNull();

    const rect = button!.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(button!.contains(hit)).toBe(true);

    await page.elementLocator(button!).click();
    expect(document.querySelector('button[class*="selectedItemRemove"]')).toBeNull();
  });
});
