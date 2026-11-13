// @vitest-environment jsdom
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Mantine from '@mantine/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// The server refuses a publish or a request without the current terms version; these pin that the
// buttons a user actually clicks send it, and that Publish stays shut until the box is ticked.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  setStatus: vi.fn(),
  request: vi.fn(),
  upsert: vi.fn(async () => undefined),
}));

vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof Mantine>()),
  Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorService.setStatus': {
      useMutation: () => ({ mutate: mocks.setStatus, isPending: false }),
    },
    'creatorService.upsert': {
      useMutation: () => ({ mutateAsync: mocks.upsert, isPending: false }),
    },
    'creatorServiceDeal.request': {
      useMutation: () => ({ mutate: mocks.request, isPending: false }),
    },
  }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'yellow' }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('~/components/Currency/CurrencyBadge', () => ({ CurrencyBadge: () => null }));

const { PublishServiceModal } = await import('~/components/CreatorShop/Services/SellerAffirmation');
const { ServiceRequestModal } = await import(
  '~/components/CreatorShop/Services/deals/ServiceRequestModal'
);
const { ServiceOfferingFormModal } = await import(
  '~/components/CreatorShop/Services/ServiceOfferingFormModal'
);

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as never;
  globalThis.ResizeObserver ??= class {
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  } as never;
});

let container: HTMLElement | undefined;
const mount = async (node: ReactNode) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container!).render(createElement(MantineProvider, null, node));
  });
  return container;
};
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});

const button = (root: HTMLElement, label: RegExp) =>
  [...root.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''))!;
const click = (el: Element) =>
  act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const tick = (root: HTMLElement) => click(root.querySelector('input[type="checkbox"]')!);

describe('seller publish', () => {
  const offering = { id: 3, title: 'Badge' };

  it('keeps Publish shut until the box is ticked, then sends the terms version', async () => {
    const root = await mount(createElement(PublishServiceModal, { offering } as never));
    expect(button(root, /Publish service/).disabled).toBe(true);
    await click(button(root, /Publish service/));
    expect(mocks.setStatus).not.toHaveBeenCalled();

    await tick(root);
    expect(button(root, /Publish service/).disabled).toBe(false);
    await click(button(root, /Publish service/));
    expect(mocks.setStatus.mock.calls[0][0]).toEqual({
      id: 3,
      status: 'Active',
      affirmedTermsVersion: SERVICES_TERMS_VERSION,
    });
  });
});

describe('service form', () => {
  const draft = {
    id: 1,
    title: 'Badge',
    description: 'A badge',
    status: 'Draft',
    price: 500,
    deliveryDays: 5,
    revisionsIncluded: 1,
    maxOpenDeals: 3,
    maxNsfwLevel: 2,
    previewKind: 'Image',
    termsAffirmed: false,
  };

  it('publishes with the terms version only after the tick, and never sends it for a draft save', async () => {
    const root = await mount(createElement(ServiceOfferingFormModal, { offering: draft } as never));
    expect(button(root, /Publish service/).disabled).toBe(true);

    await click(button(root, /Save draft/));
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({ publish: false });
    expect(mocks.upsert.mock.calls[0][0]).toHaveProperty('affirmedTermsVersion', undefined);

    await tick(root);
    await click(button(root, /Publish service/));
    expect(mocks.upsert.mock.calls[1][0]).toMatchObject({
      id: 1,
      publish: true,
      affirmedTermsVersion: SERVICES_TERMS_VERSION,
    });
  });
});

describe('buyer request', () => {
  it('sends the disclosure version with the request', async () => {
    const offering = { id: 9, title: 'Badge', price: 2500, deliveryDays: 4, revisionsIncluded: 1 };
    const root = await mount(
      createElement(ServiceRequestModal, { offering, sellerUsername: 'seller' } as never)
    );
    const textarea = root.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'please draw my cat'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(root, /Hold 2,500 Buzz and send request/));
    expect(mocks.request.mock.calls[0][0]).toMatchObject({
      offeringId: 9,
      requestText: 'please draw my cat',
      disclosureVersion: SERVICES_TERMS_VERSION,
    });
  });
});
